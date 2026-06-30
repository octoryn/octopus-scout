import { describe, it, expect } from "vitest";
import { stealthInitScript, stealthLaunchArgs, stealthLaunchOptions, uaClientHints } from "../src/fetcher/stealth.js";

describe("stealthInitScript", () => {
  it("returns a non-empty string", () => {
    const script = stealthInitScript();
    expect(typeof script).toBe("string");
    expect(script.length).toBeGreaterThan(0);
  });

  it("references the core navigator evasions", () => {
    const script = stealthInitScript();
    expect(script).toContain("webdriver");
    expect(script).toContain("languages");
    expect(script).toContain("plugins");
  });

  it("defines window.chrome and patches permissions", () => {
    const script = stealthInitScript();
    expect(script).toContain("chrome");
    expect(script).toContain("permissions");
  });

  it("includes a WebGL fingerprint evasion marker", () => {
    const script = stealthInitScript();
    const hasWebGlMarker =
      script.includes("37445") || script.includes("UNMASKED_VENDOR") || script.includes("getParameter");
    expect(hasWebGlMarker).toBe(true);
  });

  it("is deterministic across calls", () => {
    expect(stealthInitScript()).toBe(stealthInitScript());
  });
});

describe("stealthLaunchArgs", () => {
  it("disables the AutomationControlled blink feature", () => {
    const args = stealthLaunchArgs();
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("--disable-blink-features=AutomationControlled");
  });
});

describe("stealthLaunchOptions", () => {
  it("combines args with ignoreDefaultArgs", () => {
    const opts = stealthLaunchOptions();
    expect(Array.isArray(opts.args)).toBe(true);
    expect(opts.args).toContain("--disable-blink-features=AutomationControlled");
    expect(Array.isArray(opts.ignoreDefaultArgs)).toBe(true);
    expect(opts.ignoreDefaultArgs).toContain("--enable-automation");
  });
});

describe("uaClientHints", () => {
  it("returns an object with a sec-ch-ua key (case-insensitive)", () => {
    const hints = uaClientHints();
    expect(hints).toBeTypeOf("object");
    const keys = Object.keys(hints).map((k) => k.toLowerCase());
    expect(keys).toContain("sec-ch-ua");
  });

  it("reflects mobile and platform from the user-agent", () => {
    const desktop = uaClientHints(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    expect(desktop["Sec-Ch-Ua-Mobile"]).toBe("?0");
    expect(desktop["Sec-Ch-Ua-Platform"]).toBe('"Windows"');

    const mobile = uaClientHints(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
    );
    expect(mobile["Sec-Ch-Ua-Mobile"]).toBe("?1");
    expect(mobile["Sec-Ch-Ua-Platform"]).toBe('"Android"');
  });
});
