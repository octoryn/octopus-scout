import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseExtraHeaders,
  realisticUserAgent,
  stealthContextOptions,
  stealthInitScript,
  buildFetchHeaders
} from "../src/fetcher/stealth.js";

describe("parseExtraHeaders", () => {
  const ENV_KEY = "OCTORYN_SCOUT_EXTRA_HEADERS";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  });

  it("parses a valid JSON object of string values (explicit arg)", () => {
    const result = parseExtraHeaders('{"X-Token":"abc","X-Other":"def"}');
    expect(result).toEqual({ "X-Token": "abc", "X-Other": "def" });
  });

  it("coerces finite numbers and booleans to strings", () => {
    const result = parseExtraHeaders('{"X-Num":7,"X-Bool":true,"X-Str":"s"}');
    expect(result).toEqual({ "X-Num": "7", "X-Bool": "true", "X-Str": "s" });
  });

  it("drops nested objects, arrays and null values", () => {
    const result = parseExtraHeaders('{"keep":"yes","obj":{"a":1},"arr":[1,2],"nil":null}');
    expect(result).toEqual({ keep: "yes" });
  });

  it("returns {} for invalid JSON", () => {
    expect(parseExtraHeaders("not json {")).toEqual({});
  });

  it("returns {} for a non-object JSON value (array)", () => {
    expect(parseExtraHeaders("[1,2,3]")).toEqual({});
  });

  it("returns {} for a non-object JSON value (string/number/null)", () => {
    expect(parseExtraHeaders('"hi"')).toEqual({});
    expect(parseExtraHeaders("42")).toEqual({});
    expect(parseExtraHeaders("null")).toEqual({});
  });

  it("returns {} for missing/empty input", () => {
    expect(parseExtraHeaders("")).toEqual({});
    expect(parseExtraHeaders("   ")).toEqual({});
    expect(parseExtraHeaders(undefined)).toEqual({});
  });

  it("reads from OCTORYN_SCOUT_EXTRA_HEADERS env when no arg is given", () => {
    process.env[ENV_KEY] = '{"X-From-Env":"v"}';
    expect(parseExtraHeaders()).toEqual({ "X-From-Env": "v" });
  });

  it("falls back to {} when env is absent and no arg is given", () => {
    delete process.env[ENV_KEY];
    expect(parseExtraHeaders()).toEqual({});
  });
});

describe("realisticUserAgent", () => {
  it("returns a string containing Mozilla and Chrome", () => {
    const ua = realisticUserAgent();
    expect(typeof ua).toBe("string");
    expect(ua).toContain("Mozilla");
    expect(ua).toContain("Chrome");
  });
});

describe("stealthContextOptions", () => {
  it("returns userAgent, en-US locale, timezoneId and a viewport", () => {
    const opts = stealthContextOptions();
    expect(typeof opts.userAgent).toBe("string");
    expect(opts.userAgent).toContain("Mozilla");
    expect(opts.locale).toBe("en-US");
    expect(typeof opts.timezoneId).toBe("string");
    expect(opts.timezoneId.length).toBeGreaterThan(0);
    expect(typeof opts.viewport.width).toBe("number");
    expect(typeof opts.viewport.height).toBe("number");
    expect(opts.viewport.width).toBeGreaterThan(0);
    expect(opts.viewport.height).toBeGreaterThan(0);
  });
});

describe("stealthInitScript", () => {
  it("returns a string mentioning webdriver", () => {
    const script = stealthInitScript();
    expect(typeof script).toBe("string");
    expect(script).toContain("webdriver");
  });
});

describe("buildFetchHeaders", () => {
  it("merges base with extra, extra winning on key conflicts", () => {
    const result = buildFetchHeaders(
      { "X-Base": "base", "X-Shared": "fromBase" },
      { extra: { "X-Shared": "fromExtra", "X-Extra": "e" } }
    );
    expect(result["X-Base"]).toBe("base");
    expect(result["X-Shared"]).toBe("fromExtra");
    expect(result["X-Extra"]).toBe("e");
  });

  it("returns a shallow copy of base when no opts are given", () => {
    const base = { A: "1" };
    const result = buildFetchHeaders(base);
    expect(result).toEqual({ A: "1" });
    expect(result).not.toBe(base);
  });

  it("adds an Accept-Language header when stealth is true", () => {
    const result = buildFetchHeaders({}, { stealth: true });
    expect(result["Accept-Language"]).toBeDefined();
    expect(result["Accept-Language"]).toContain("en-US");
  });

  it("lets extra override stealth headers on key conflicts", () => {
    const result = buildFetchHeaders({}, { stealth: true, extra: { "Accept-Language": "fr-FR" } });
    expect(result["Accept-Language"]).toBe("fr-FR");
  });

  it("does not add stealth headers when stealth is falsy", () => {
    const result = buildFetchHeaders({ Host: "x" });
    expect(result["Accept-Language"]).toBeUndefined();
  });
});
