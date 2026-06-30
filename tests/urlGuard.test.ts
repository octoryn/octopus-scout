import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPrivateIp, assertUrlAllowed, UrlNotAllowedError } from "../src/fetcher/urlGuard.js";

// urlGuard's assertUrlAllowed reads config via loadConfig(process.env) on every
// call (no module-level caching), so snapshotting and restoring process.env
// around each test is sufficient to keep these hermetic. We deliberately use IP
// literals / localhost so no real DNS lookup is performed.

const PRIVATE_ENV_KEYS = [
  "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
  "OCTORYN_SCOUT_HOST_ALLOWLIST",
  "OCTORYN_SCOUT_HOST_BLOCKLIST"
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of PRIVATE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PRIVATE_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isPrivateIp", () => {
  const privateCases = [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "::ffff:127.0.0.1"
  ];

  for (const ip of privateCases) {
    it(`treats ${ip} as private`, () => {
      expect(isPrivateIp(ip)).toBe(true);
    });
  }

  const publicCases = ["8.8.8.8", "1.1.1.1", "2606:4700::1"];

  for (const ip of publicCases) {
    it(`treats ${ip} as public`, () => {
      expect(isPrivateIp(ip)).toBe(false);
    });
  }
});

describe("assertUrlAllowed", () => {
  it("rejects a non-http(s) protocol", async () => {
    await expect(assertUrlAllowed("ftp://x")).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  it("rejects an http URL whose host is a private IP literal", async () => {
    await expect(assertUrlAllowed("http://127.0.0.1/")).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  it("attaches statusCode 400 to the thrown error", async () => {
    let caught: unknown;
    try {
      await assertUrlAllowed("http://127.0.0.1/");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UrlNotAllowedError);
    expect((caught as UrlNotAllowedError).statusCode).toBe(400);
  });

  it("allows a public IP-literal host (no DNS required)", async () => {
    await expect(assertUrlAllowed("http://1.1.1.1/")).resolves.toBeUndefined();
  });

  it("allows a private IP literal when OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true", async () => {
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    await expect(assertUrlAllowed("http://127.0.0.1/")).resolves.toBeUndefined();
  });

  it("blocks a host that is on the blocklist", async () => {
    process.env.OCTORYN_SCOUT_HOST_BLOCKLIST = "1.1.1.1";
    await expect(assertUrlAllowed("http://1.1.1.1/")).rejects.toBeInstanceOf(UrlNotAllowedError);
  });

  it("blocks a host that is not on the allowlist", async () => {
    process.env.OCTORYN_SCOUT_HOST_ALLOWLIST = "8.8.8.8";
    await expect(assertUrlAllowed("http://1.1.1.1/")).rejects.toBeInstanceOf(UrlNotAllowedError);
  });
});
