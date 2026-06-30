import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Hermetic proof that the per-domain policy rateLimitMs is actually honored at
 * the fetch layer.
 *
 * Previously effectiveRateLimitMs was exported and unit-tested but had no
 * caller in src/, so a policy's domain.rateLimitMs was a silent no-op. This
 * test mocks rateLimiter.waitForDomainSlot to capture the interval handed to
 * the gate (NO real sleeps / timing waits) and asserts that fetchResource
 * passes the policy-widened value through.
 *
 * The fetch itself targets a loopback node:http server so no external network
 * or chromium is needed; the rate-limit gate is stubbed to a resolved no-op.
 */

interface Listener {
  origin: string;
  host: string;
  close: () => Promise<void>;
}

const BODY = "rate limit wiring fixture body content";

async function startServer(): Promise<Listener | null> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body>${BODY}</body></html>`);
  });

  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => resolve(true));
  });
  if (!bound) {
    return null;
  }

  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    host: "127.0.0.1",
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

// Capture the interval argument passed to waitForDomainSlot without sleeping.
const slotCalls: Array<{ url: string; minIntervalMs: number }> = [];
vi.mock("../src/fetcher/rateLimiter.js", () => ({
  waitForDomainSlot: vi.fn(async (url: string, minIntervalMs: number) => {
    slotCalls.push({ url, minIntervalMs });
  })
}));

const ENV_KEYS = [
  "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
  "OCTORYN_SCOUT_POLICY_FILE",
  "OCTORYN_SCOUT_DOMAIN_RATE_LIMIT_MS"
] as const;

describe("per-domain rate limit wiring (fetchResource -> effectiveRateLimitMs)", () => {
  const saved: Record<string, string | undefined> = {};
  let listener: Listener | null = null;
  let tmpDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    tmpDir = mkdtempSync(join(tmpdir(), `ratewire-${randomUUID()}-`));
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    // Base delay 0 so the asserted value is unambiguously the policy override.
    process.env.OCTORYN_SCOUT_DOMAIN_RATE_LIMIT_MS = "0";
    slotCalls.length = 0;
    vi.resetModules();
  });

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("widens the gate interval to the policy's per-domain rateLimitMs", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const policyPath = join(tmpDir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: "ratewire-v1",
        defaultAction: "allow",
        domains: [{ domain: listener.host, action: "allow", rateLimitMs: 750 }]
      }),
      "utf8"
    );
    process.env.OCTORYN_SCOUT_POLICY_FILE = policyPath;

    const { resetPolicyCache } = await import("../src/governance/policy.js");
    resetPolicyCache();
    const { fetchResource } = await import("../src/fetcher/httpFetcher.js");

    await fetchResource(`${listener.origin}/`);

    expect(slotCalls).toHaveLength(1);
    // Base is 0 (env above); the policy override of 750 must win.
    expect(slotCalls[0].minIntervalMs).toBe(750);
  });

  it("leaves the base interval untouched when no domain policy matches", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const policyPath = join(tmpDir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: "ratewire-v1",
        defaultAction: "allow",
        domains: [{ domain: "unrelated.example", action: "allow", rateLimitMs: 9000 }]
      }),
      "utf8"
    );
    process.env.OCTORYN_SCOUT_POLICY_FILE = policyPath;

    const { resetPolicyCache } = await import("../src/governance/policy.js");
    resetPolicyCache();
    const { fetchResource } = await import("../src/fetcher/httpFetcher.js");

    // Caller-supplied base of 120 with no matching domain => effective stays 120.
    await fetchResource(`${listener.origin}/`, { rateLimitMs: 120 });

    expect(slotCalls).toHaveLength(1);
    expect(slotCalls[0].minIntervalMs).toBe(120);
  });
});
