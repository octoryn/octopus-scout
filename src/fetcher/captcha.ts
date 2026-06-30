/**
 * CAPTCHA solver seam — PROVIDER FRAMEWORK ONLY (no solving is implemented).
 *
 * The full integration standard lives in `docs/CAPTCHA.md`. In short:
 *
 *  - The engine DETECTS CAPTCHA challenges from page content ({@link detectCaptcha}).
 *  - It NEVER solves them. Solving modern CAPTCHAs (reCAPTCHA v2/v3, hCaptcha,
 *    Cloudflare Turnstile) requires an external service or ML model, which is
 *    sensitive (ToS / authorization) and intentionally left to the operator.
 *  - Operators with authorization and their own solver register it via
 *    {@link registerCaptchaSolver} and select it with `OCTORYN_SCOUT_CAPTCHA_PROVIDER`.
 *
 * This module ships: a registry, a {@link NoopCaptchaSolver} default (declines
 * everything), an inert {@link ExternalSolverTemplate} that documents the shape
 * a real adapter takes WITHOUT performing any solving, and detection helpers.
 *
 * Never throws at import time.
 *
 * TODO(captcha): operators implement an external solver adapter (BYO key) per
 * docs/CAPTCHA.md — not provided here by design.
 */

import type { CaptchaChallenge, CaptchaSolution, CaptchaSolver, CaptchaSolverFactory } from "../types.js";
import { loadConfig } from "../config.js";

/** Sentinel: this module is a framework/placeholder, not a working solver. */
export const CAPTCHA_TODO = true;

// ---------------------------------------------------------------------------
// Default solver — declines everything
// ---------------------------------------------------------------------------

/** No-op solver. `solve()` always resolves to `null` (decline). */
export class NoopCaptchaSolver implements CaptchaSolver {
  readonly name = "none";

  async solve(_challenge: CaptchaChallenge): Promise<CaptchaSolution | null> {
    return null;
  }
}

/**
 * Inert reference template for an external-service adapter. It documents the
 * exact shape a real solver takes but performs NO network calls and solves
 * NOTHING — `solve()` returns `null`. Copy this into your own module, implement
 * the marked section against your solver service, and register it. It is NOT
 * registered by default.
 *
 * @example
 *   class MySolver extends ExternalSolverTemplate {
 *     readonly name = "my-solver";
 *     async solve(c: CaptchaChallenge): Promise<CaptchaSolution | null> {
 *       // POST c.siteKey + c.url to your solving service (BYO key), poll for the
 *       // token, then: return { token, provider: this.name, solvedAt: new Date().toISOString() };
 *       return null;
 *     }
 *   }
 *   registerCaptchaSolver("my-solver", () => new MySolver());
 */
export abstract class ExternalSolverTemplate implements CaptchaSolver {
  abstract readonly name: string;
  protected readonly apiKey?: string;

  constructor(apiKey = loadConfig().captchaApiKey) {
    this.apiKey = apiKey;
  }

  async solve(_challenge: CaptchaChallenge): Promise<CaptchaSolution | null> {
    // Intentionally not implemented. See docs/CAPTCHA.md.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, CaptchaSolverFactory>();

/**
 * Register a solver factory under a provider name. Selecting that name via
 * `OCTORYN_SCOUT_CAPTCHA_PROVIDER` makes {@link getCaptchaSolver} return it.
 * Registering "none" is ignored (reserved for the built-in no-op).
 */
export function registerCaptchaSolver(name: string, factory: CaptchaSolverFactory): void {
  if (name && name !== "none") registry.set(name, factory);
}

/** Test/util: clear all registered solvers. */
export function clearCaptchaSolvers(): void {
  registry.clear();
}

/**
 * Resolve the active solver from `config.captchaProvider`. Returns the
 * registered factory's solver, or {@link NoopCaptchaSolver} for "none" / any
 * unregistered name. Never throws.
 */
export function getCaptchaSolver(): CaptchaSolver {
  const provider = loadConfig().captchaProvider;
  if (provider && provider !== "none") {
    const factory = registry.get(provider);
    if (factory) {
      try {
        return factory();
      } catch {
        // A misbehaving factory must not break the fetch path.
        return new NoopCaptchaSolver();
      }
    }
  }
  return new NoopCaptchaSolver();
}

// ---------------------------------------------------------------------------
// Detection (reading the page is fine; solving is not)
// ---------------------------------------------------------------------------

/**
 * Detect a CAPTCHA challenge from page HTML and extract its site key, so a
 * registered solver has everything it needs. Returns `undefined` when no known
 * CAPTCHA widget is present. Detection only — no solving.
 */
export function detectCaptcha(html: string, url: string): CaptchaChallenge | undefined {
  if (typeof html !== "string" || html.length === 0) return undefined;

  const turnstile = /class=["'][^"']*cf-turnstile[^"']*["'][^>]*data-sitekey=["']([^"']+)["']/i.exec(html);
  if (turnstile || /\bcf-turnstile\b/i.test(html)) {
    return { kind: "turnstile", url, siteKey: turnstile?.[1] };
  }

  const hcaptcha = /class=["'][^"']*h-captcha[^"']*["'][^>]*data-sitekey=["']([^"']+)["']/i.exec(html);
  if (hcaptcha || /\bh-captcha\b/i.test(html) || /hcaptcha\.com\/1\/api\.js/i.test(html)) {
    return { kind: "hcaptcha", url, siteKey: hcaptcha?.[1] };
  }

  const recaptcha = /class=["'][^"']*g-recaptcha[^"']*["'][^>]*data-sitekey=["']([^"']+)["']/i.exec(html);
  if (
    recaptcha ||
    /\bg-recaptcha\b/i.test(html) ||
    /www\.(google|recaptcha)\.[a-z.]+\/recaptcha\/api\.js/i.test(html)
  ) {
    return { kind: "recaptcha-v2", url, siteKey: recaptcha?.[1] };
  }

  return undefined;
}
