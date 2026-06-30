import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isChallengePage, challengeKind } from "../src/fetcher/challenge.js";

/**
 * Pure, hermetic unit tests for the interstitial JS-challenge detection
 * helpers. These exercise only the synchronous string-heuristic functions
 * (`isChallengePage`, `challengeKind`) — no browser is launched, and
 * `waitForChallenge` (which needs a Playwright Page) is intentionally not
 * tested here.
 */

const CLOUDFLARE_JUST_A_MOMENT = `<!DOCTYPE html>
<html lang="en-US">
<head><title>Just a moment...</title></head>
<body>
  <div class="cf-browser-verification cf-im-under-attack">
    <h1>Checking your browser before accessing example.com.</h1>
    <p>Enable JavaScript and cookies to continue</p>
    <div id="challenge-platform"></div>
  </div>
</body>
</html>`;

const TURNSTILE_PAGE = `<!DOCTYPE html>
<html><head><title>Attention Required</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
</head>
<body><div class="cf-turnstile" data-sitekey="abc"></div></body>
</html>`;

const NORMAL_ARTICLE = `<!DOCTYPE html>
<html lang="en">
<head><title>How octopuses camouflage</title></head>
<body>
  <article>
    <h1>How octopuses camouflage</h1>
    <p>Octopuses change color using chromatophores in their skin. This is a
       perfectly normal article about marine biology with no challenge text.</p>
  </article>
</body>
</html>`;

describe("isChallengePage", () => {
  it('detects a Cloudflare "Just a moment" interstitial', () => {
    expect(isChallengePage(CLOUDFLARE_JUST_A_MOMENT)).toBe(true);
  });

  it('detects "cf-browser-verification" marker', () => {
    expect(isChallengePage('<div class="cf-browser-verification"></div>')).toBe(true);
  });

  it('detects "Checking your browser" marker', () => {
    expect(isChallengePage("<h1>Checking your browser before accessing site</h1>")).toBe(true);
  });

  it("detects challenge markers regardless of letter case", () => {
    expect(isChallengePage("<title>JUST A MOMENT...</title>")).toBe(true);
  });

  it("still detects a challenge when accompanied by a 503 status", () => {
    expect(isChallengePage(CLOUDFLARE_JUST_A_MOMENT, 503)).toBe(true);
  });

  it("detects a Turnstile widget page", () => {
    expect(isChallengePage(TURNSTILE_PAGE)).toBe(true);
  });

  it("treats a 503 Cloudflare ray-id block page as a challenge", () => {
    const block = "<html><body>Error 1015 <span>cf-ray: 7abc</span></body></html>";
    expect(isChallengePage(block, 503)).toBe(true);
  });

  it("returns false for a normal article page (no status)", () => {
    expect(isChallengePage(NORMAL_ARTICLE)).toBe(false);
  });

  it("returns false for a normal article page even with a 503 status", () => {
    expect(isChallengePage(NORMAL_ARTICLE, 503)).toBe(false);
  });

  it("returns false for empty or non-string input", () => {
    expect(isChallengePage("")).toBe(false);
    // @ts-expect-error exercising the runtime guard for non-string input
    expect(isChallengePage(undefined)).toBe(false);
  });
});

describe("challengeKind", () => {
  it("labels a classic JS challenge as cloudflare-jschl", () => {
    expect(challengeKind(CLOUDFLARE_JUST_A_MOMENT)).toBe("cloudflare-jschl");
  });

  it("labels a Turnstile page as cloudflare-turnstile", () => {
    expect(challengeKind(TURNSTILE_PAGE)).toBe("cloudflare-turnstile");
  });

  it('labels a non-Cloudflare "enable JavaScript" interstitial as generic-js', () => {
    expect(challengeKind("<p>enable javascript and cookies to continue</p>")).toBe("generic-js");
  });

  it("returns undefined for a normal article page", () => {
    expect(challengeKind(NORMAL_ARTICLE)).toBeUndefined();
  });

  it("returns undefined for empty or non-string input", () => {
    expect(challengeKind("")).toBeUndefined();
    // @ts-expect-error exercising the runtime guard for non-string input
    expect(challengeKind(null)).toBeUndefined();
  });
});

// These hooks are unused by the pure tests above but kept imported per the
// test-suite conventions; reference them to satisfy lint without side effects.
beforeEach(() => void 0);
afterEach(() => void 0);
afterAll(() => void 0);
void vi;
