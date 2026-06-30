import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { loadConfig } from "../config.js";
import type { ProxyConfig, RenderedResource, ScrapeAction } from "../types.js";
import { domainOf, normalizeUrl } from "../utils/url.js";
import { waitForDomainSlot } from "../fetcher/rateLimiter.js";
import { assertUrlAllowed } from "../fetcher/urlGuard.js";
import {
  parseExtraHeaders,
  stealthContextOptions,
  stealthInitScript,
  stealthLaunchOptions,
  uaClientHints
} from "../fetcher/stealth.js";
import { pickProxy } from "../fetcher/proxy.js";
import { waitForChallenge } from "../fetcher/challenge.js";
import { recordBytes, recordDomain, recordRequest, recordStatus } from "../metrics.js";

export interface RenderOptions {
  timeoutMs?: number;
  waitForSelector?: string;
  includeScreenshot?: boolean;
  actions?: ScrapeAction[];
  /**
   * Explicit proxy to route the page's network through. When omitted, a proxy
   * is selected from the configured pool via {@link pickProxy}; when none is
   * configured the render goes direct.
   */
  proxy?: ProxyConfig;
}

/**
 * A real Chromium browser pool.
 *
 * - One lazily-launched headless Chromium {@link Browser} is shared across jobs.
 * - Concurrent pages are bounded to `config.browserMaxPages` via an async FIFO
 *   semaphore; callers past capacity wait and resume in arrival order.
 * - Every job runs in its own {@link BrowserContext} for isolation and the
 *   context is always disposed in `finally`.
 * - When no pages are active for `config.browserIdleMs`, the browser is closed
 *   automatically and transparently relaunched on the next call. The idle timer
 *   is `unref`'d so it never keeps the Node process alive.
 */
class BrowserPool {
  private browser?: Browser;
  /** In-flight launch, so concurrent first callers share one launch. */
  private launching?: Promise<Browser>;
  /** Number of pages currently checked out (active jobs). */
  private activePages = 0;
  /** FIFO queue of waiters blocked on the concurrency limit. */
  private readonly waiters: Array<() => void> = [];
  /** Capacity of the most recent launch; tracked so the limit stays stable. */
  private maxPages = 1;
  private idleTimer?: ReturnType<typeof setTimeout>;
  /**
   * Monotonic generation counter. Incremented on every (re)launch so that a
   * stale idle timer from a previous browser instance can detect it is stale
   * and decline to act.
   */
  private generation = 0;

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }
    if (this.launching) {
      return this.launching;
    }

    const config = loadConfig();
    this.maxPages = Math.max(1, config.browserMaxPages);

    // Only apply the automation-hiding launch flags when stealth is enabled, so
    // default behavior (and existing tests) are unaffected. stealthLaunchOptions
    // contributes `args` (--disable-blink-features=AutomationControlled) and
    // `ignoreDefaultArgs` (drops --enable-automation, killing the banner).
    const launchOptions: Parameters<typeof chromium.launch>[0] = { headless: true };
    if (config.stealth) {
      const stealthLaunch = stealthLaunchOptions();
      launchOptions.args = [...(launchOptions.args ?? []), ...stealthLaunch.args];
      launchOptions.ignoreDefaultArgs = [
        ...(Array.isArray(launchOptions.ignoreDefaultArgs) ? launchOptions.ignoreDefaultArgs : []),
        ...stealthLaunch.ignoreDefaultArgs
      ];
    }

    this.launching = chromium
      .launch(launchOptions)
      .then((browser) => {
        this.browser = browser;
        this.generation += 1;
        this.launching = undefined;
        return browser;
      })
      .catch((err) => {
        this.launching = undefined;
        throw err;
      });

    return this.launching;
  }

  /** Acquire a concurrency slot, waiting FIFO when at capacity. */
  private async acquireSlot(): Promise<void> {
    if (this.activePages < this.maxPages) {
      this.activePages += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // Slot ownership was transferred to us by releaseSlot (it kept the count).
  }

  /** Release a slot, handing it to the next FIFO waiter if any. */
  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      // Keep activePages unchanged: the slot transfers directly to the waiter.
      next();
    } else {
      this.activePages -= 1;
      if (this.activePages <= 0) {
        this.activePages = 0;
        this.scheduleIdleShutdown();
      }
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    const config = loadConfig();
    const idleMs = config.browserIdleMs;
    if (idleMs <= 0) {
      return;
    }
    const launchedGeneration = this.generation;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // Only shut down if nothing happened since this timer was armed and the
      // browser instance is still the one we scheduled for.
      if (this.activePages === 0 && this.generation === launchedGeneration && this.browser) {
        const toClose = this.browser;
        this.browser = undefined;
        void toClose.close().catch(() => undefined);
      }
    }, idleMs);
    // Do not let the idle timer keep the process alive.
    this.idleTimer.unref?.();
  }

  /**
   * Run `fn` with a fresh isolated page. Bounded by the configured page limit
   * and run inside its own browser context which is always closed afterwards.
   *
   * When `config.stealth` is enabled the context is created with
   * {@link stealthContextOptions} (UA/locale/timezone/viewport) and a stealth
   * init script is injected into every page; otherwise the default context
   * uses `config.userAgent`. Configured extra HTTP headers (from
   * {@link parseExtraHeaders}) are always applied when present.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>, opts?: { proxy?: ProxyConfig }): Promise<T> {
    await this.acquireSlot();
    this.clearIdleTimer();

    let browser: Browser;
    try {
      browser = await this.ensureBrowser();
    } catch (err) {
      // Failed to launch: surrender the slot so others are not starved.
      this.releaseSlot();
      throw err;
    }

    const config = loadConfig();
    // Resolve a proxy: explicit option wins, else round-robin the configured
    // pool. Undefined => direct (graceful degradation). Playwright's native
    // per-context proxy option matches ProxyConfig's shape exactly.
    const proxy = opts?.proxy ?? pickProxy();

    let context: BrowserContext | undefined;
    try {
      const contextOptions: BrowserContextOptions = config.stealth
        ? { ...stealthContextOptions() }
        : { userAgent: config.userAgent };
      if (proxy) {
        contextOptions.proxy = {
          server: proxy.server,
          ...(proxy.username !== undefined ? { username: proxy.username } : {}),
          ...(proxy.password !== undefined ? { password: proxy.password } : {})
        };
      }

      context = await browser.newContext(contextOptions);
      if (config.stealth) {
        await context.addInitScript(stealthInitScript());
      }

      // Configured extra headers, plus UA-consistent Client Hints when stealth.
      const extraHeaders: Record<string, string> = parseExtraHeaders();
      if (config.stealth) {
        const ctxUserAgent = (contextOptions as { userAgent?: string }).userAgent;
        Object.assign(extraHeaders, uaClientHints(ctxUserAgent));
      }
      if (Object.keys(extraHeaders).length > 0) {
        await context.setExtraHTTPHeaders(extraHeaders);
      }

      const page = await context.newPage();
      return await fn(page);
    } finally {
      if (context) {
        await context.close().catch(() => undefined);
      }
      this.releaseSlot();
    }
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    // Wake any waiters so they don't hang forever; their acquired slot will
    // simply fail at ensureBrowser/launch time if the pool is reused.
    const launching = this.launching;
    const browser = this.browser;
    this.browser = undefined;
    if (launching) {
      await launching.catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export const browserPool = new BrowserPool();

/**
 * Execute pre-capture {@link ScrapeAction}s in order against `page`. Each action
 * is isolated in its own try/catch so one failure never aborts the render; any
 * "screenshot" action appends a base64 PNG to the returned array. Never throws.
 */
async function runActions(page: Page, actions: ScrapeAction[], timeoutMs: number): Promise<string[]> {
  const actionScreenshots: string[] = [];
  for (const action of actions) {
    try {
      switch (action.type) {
        case "wait":
          await page.waitForTimeout(action.ms);
          break;
        case "waitForSelector":
          await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? timeoutMs });
          break;
        case "click":
          await page.click(action.selector);
          break;
        case "scroll": {
          const amount = action.amount;
          const direction = action.direction ?? "down";
          await page.evaluate(
            ({ amount, direction }) => {
              const step = amount ?? window.innerHeight;
              window.scrollBy(0, direction === "up" ? -step : step);
            },
            { amount, direction }
          );
          break;
        }
        case "type":
          await page.fill(action.selector, action.text);
          break;
        case "press":
          await page.keyboard.press(action.key);
          break;
        case "screenshot": {
          const shot = (await page.screenshot({ type: "png" })).toString("base64");
          actionScreenshots.push(shot);
          break;
        }
        default:
          // Exhaustiveness guard: unknown action types are ignored.
          break;
      }
    } catch {
      // A single failing action must not abort the render: continue to the next.
    }
  }
  return actionScreenshots;
}

export async function renderResource(inputUrl: string, options: RenderOptions = {}): Promise<RenderedResource> {
  const config = loadConfig();
  const url = normalizeUrl(inputUrl);
  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;
  const started = performance.now();

  recordRequest("render");
  recordDomain(domainOf(url));

  await assertUrlAllowed(url);

  await waitForDomainSlot(url, config.domainRateLimitMs);

  return browserPool.withPage(
    async (page) => {
      // SSRF guard on navigations: a 3xx redirect re-navigates the main frame to
      // the Location, which page.goto follows transparently. Re-validate every
      // top-level navigation (incl. redirect hops) and abort private/blocked
      // targets. Subresources are not the SSRF vector and are left untouched to
      // avoid the per-request DNS cost.
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          try {
            await assertUrlAllowed(request.url());
          } catch {
            await route.abort("blockedbyclient");
            return;
          }
        }
        await route.continue();
      });

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs
      });

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: timeoutMs });
      } else {
        await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) }).catch(() => undefined);
      }

      // Wait out any interstitial JS challenge (Cloudflare "Just a moment", etc.)
      // BEFORE running actions / capturing content, so the cleared real DOM is
      // what we capture. Safe to call unconditionally: returns immediately when
      // the page is not a challenge, and never throws.
      await waitForChallenge(page, { maxWaitMs: config.challengeMaxWaitMs });

      const actionScreenshots =
        options.actions && options.actions.length > 0 ? await runActions(page, options.actions, timeoutMs) : [];

      const body = Buffer.from(await page.content());
      recordStatus(response?.status() ?? 0);
      recordBytes(body.byteLength);
      const screenshotBase64 = options.includeScreenshot
        ? (await page.screenshot({ fullPage: true, type: "png" })).toString("base64")
        : undefined;
      const headers = response ? await response.allHeaders() : {};

      return {
        url,
        finalUrl: page.url(),
        status: response?.status() ?? 0,
        ok: response?.ok() ?? true,
        contentType: headers["content-type"] ?? "text/html; charset=utf-8",
        headers,
        body,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        screenshotBase64,
        actionScreenshots: actionScreenshots.length > 0 ? actionScreenshots : undefined
      };
    },
    { proxy: options.proxy }
  );
}
