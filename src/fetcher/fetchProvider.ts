import { loadConfig } from "../config.js";
import { renderResource } from "../browser/browserPool.js";
import { fetchResource } from "../fetcher/httpFetcher.js";
import type {
  FetchProvider,
  FetchProviderOptions,
  FetchProviderResult,
  FetchedResource,
  RenderMode
} from "../types.js";

/**
 * Decide whether a browser render is needed for a static {@link FetchedResource}.
 *
 * This is the render-decision logic that previously lived inline in the ingest
 * pipeline, moved here so the FetchProvider seam owns the full static->render
 * choice:
 * - "browser" => always render.
 * - "static"  => never render.
 * - "auto"    => render only when the response is HTML, the visible text is
 *                sparse (< 500 chars after stripping tags/scripts/styles) AND a
 *                <script> tag is present (i.e. likely client-rendered).
 */
function shouldRender(renderMode: RenderMode, resource: FetchedResource): boolean {
  if (renderMode === "browser") {
    return true;
  }
  if (renderMode === "static") {
    return false;
  }
  if (!resource.contentType.includes("html")) {
    return false;
  }

  const html = resource.body.toString("utf8");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length < 500 && /<script\b/i.test(html);
}

/**
 * The default local fetch engine: a static {@link fetchResource} followed by an
 * optional pooled-browser {@link renderResource}, with stealth/proxy/challenge
 * handling inherited from those layers. Behavior with no proxy and stealth off
 * is identical to the original inline pipeline path.
 */
export class LocalFetchProvider implements FetchProvider {
  readonly name = "local";

  async fetch(url: string, options: FetchProviderOptions): Promise<FetchProviderResult> {
    // Static fetch first (existing behavior). Proxy/rate-limit/stealth handling
    // lives inside fetchResource; we don't override the proxy here so the pool's
    // round-robin selection is preserved.
    const staticResource = await fetchResource(url, { timeoutMs: options.timeoutMs });

    if (!shouldRender(options.render, staticResource)) {
      return {
        resource: staticResource,
        rendered: false,
        provider: this.name
      };
    }

    const rendered = await renderResource(url, {
      timeoutMs: options.timeoutMs,
      waitForSelector: options.waitForSelector,
      includeScreenshot: options.includeScreenshot,
      actions: options.actions
    });

    // NOTE: we intentionally do NOT report proxyServer here. Calling pickProxy()
    // again would advance the round-robin cursor a second time and return a
    // proxy different from the one actually used by the fetch/render. Surfacing
    // the real proxy would require threading it out of the fetch layer; until
    // then, omitting is correct (better no value than a fabricated one).
    return {
      resource: rendered,
      rendered: true,
      provider: this.name
    };
  }
}

let localSingleton: LocalFetchProvider | undefined;

/**
 * Resolve the configured {@link FetchProvider}. Today only "local" exists; the
 * switch is structured so a future external provider is another case without
 * touching call sites. Falls back to local on any unknown value (never throws).
 */
export function getFetchProvider(): FetchProvider {
  const config = loadConfig();
  switch (config.fetchProvider) {
    case "local":
    default:
      if (!localSingleton) {
        localSingleton = new LocalFetchProvider();
      }
      return localSingleton;
  }
}
