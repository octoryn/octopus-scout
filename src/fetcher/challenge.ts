import type { Page } from "playwright";
import { loadConfig } from "../config.js";

/**
 * Interstitial JS-challenge handling (Cloudflare "Just a moment", etc.).
 *
 * This module does NOT solve challenges. Cloudflare-style interstitials run a
 * JavaScript proof-of-work / fingerprint check in the browser and then redirect
 * to the real page. When we render with a real browser, the browser executes
 * that JS itself — all we have to do is detect that we are sitting on the
 * interstitial and *wait it out* until the real content appears.
 *
 * Everything here is conservative (avoid false positives on normal pages),
 * pure where possible, and never throws.
 */

/**
 * Lowercased substring markers that strongly indicate an interstitial JS
 * challenge page. Kept narrow on purpose: these strings essentially never
 * appear in normal page bodies.
 */
const CHALLENGE_MARKERS: readonly string[] = [
  "just a moment",
  "checking your browser",
  "cf-browser-verification",
  "cf_chl",
  "__cf_chl",
  "challenge-platform",
  "enable javascript and cookies to continue"
];

/**
 * Turnstile-specific markers (Cloudflare's CAPTCHA-ish widget). Detected
 * separately so `challengeKind` can label them, but they still count as a
 * challenge page for `isChallengePage`.
 */
const TURNSTILE_MARKERS: readonly string[] = ["cf-turnstile", "turnstile/v0/api.js", "challenges.cloudflare.com"];

function hasMarker(haystack: string, markers: readonly string[]): boolean {
  for (const m of markers) {
    if (haystack.includes(m)) return true;
  }
  return false;
}

/**
 * Heuristic detection of an interstitial JS-challenge page from its HTML
 * (and optional HTTP status).
 *
 * Conservative by design: a page matches if it contains one of the known
 * challenge markers, OR if it is a 403/503 that carries a Cloudflare ray-id
 * marker (the "ray id"/"cf-ray" footer that Cloudflare block/challenge pages
 * render). Normal pages do not contain these strings, so false positives are
 * unlikely.
 */
export function isChallengePage(html: string, status?: number): boolean {
  if (typeof html !== "string" || html.length === 0) return false;
  const lower = html.toLowerCase();

  if (hasMarker(lower, CHALLENGE_MARKERS)) return true;
  if (hasMarker(lower, TURNSTILE_MARKERS)) return true;

  // A 403/503 from Cloudflare's edge that shows a ray-id footer is almost
  // always a block/challenge interstitial rather than real content.
  if ((status === 403 || status === 503) && (lower.includes("cf-ray") || lower.includes("cloudflare ray id"))) {
    return true;
  }

  return false;
}

/**
 * Best-effort label for an interstitial challenge, for logging/metrics only.
 *
 * Returns:
 * - "cloudflare-turnstile" when a Turnstile widget is present;
 * - "cloudflare-jschl" for the classic JS-challenge ("Just a moment" / cf_chl);
 * - "generic-js" when a non-Cloudflare "enable JavaScript"-style interstitial
 *   is detected;
 * - undefined when the page does not look like a challenge.
 */
export function challengeKind(html: string): string | undefined {
  if (typeof html !== "string" || html.length === 0) return undefined;
  const lower = html.toLowerCase();

  if (hasMarker(lower, TURNSTILE_MARKERS)) return "cloudflare-turnstile";

  if (
    lower.includes("cf_chl") ||
    lower.includes("__cf_chl") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("challenge-platform") ||
    lower.includes("just a moment") ||
    lower.includes("checking your browser")
  ) {
    return "cloudflare-jschl";
  }

  if (lower.includes("enable javascript and cookies to continue")) {
    return "generic-js";
  }

  return undefined;
}

/**
 * If the current page looks like an interstitial JS challenge, wait for the
 * browser to clear it (it executes the challenge JS itself), polling until the
 * page no longer looks like a challenge or `maxWaitMs` elapses.
 *
 * - `maxWaitMs` defaults to `loadConfig().challengeMaxWaitMs`.
 * - Never throws: any error reading page state is treated as "give up" and
 *   returns `{ passed: false }` with the elapsed time so far.
 * - When the page does not look like a challenge to begin with, returns
 *   immediately with `{ passed: true, waitedMs: 0 }`.
 */
export async function waitForChallenge(
  page: Page,
  opts?: { maxWaitMs?: number }
): Promise<{ passed: boolean; waitedMs: number }> {
  let maxWaitMs = opts?.maxWaitMs;
  if (maxWaitMs === undefined) {
    try {
      maxWaitMs = loadConfig().challengeMaxWaitMs;
    } catch {
      maxWaitMs = 15_000;
    }
  }
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) maxWaitMs = 0;

  const start = Date.now();

  // Initial check: is this even a challenge page?
  const looksLikeChallenge = async (): Promise<boolean> => {
    let html = "";
    try {
      html = await page.content();
    } catch {
      // Page navigating/closed: cannot read => assume not a challenge so we
      // don't loop pointlessly.
      return false;
    }
    if (isChallengePage(html)) return true;
    // Title-only fallback (some interstitials render the body via JS).
    try {
      const title = (await page.title()).toLowerCase();
      if (
        title.includes("just a moment") ||
        title.includes("checking your browser") ||
        title.includes("attention required")
      ) {
        return true;
      }
    } catch {
      // ignore title errors
    }
    return false;
  };

  if (!(await looksLikeChallenge())) {
    return { passed: true, waitedMs: 0 };
  }

  const pollMs = 250;
  while (Date.now() - start < maxWaitMs) {
    const remaining = maxWaitMs - (Date.now() - start);
    try {
      await page.waitForTimeout(Math.min(pollMs, Math.max(0, remaining)));
    } catch {
      // page closed mid-wait
      return { passed: false, waitedMs: Date.now() - start };
    }
    if (!(await looksLikeChallenge())) {
      return { passed: true, waitedMs: Date.now() - start };
    }
  }

  // Timed out still on the challenge.
  return { passed: false, waitedMs: Date.now() - start };
}
