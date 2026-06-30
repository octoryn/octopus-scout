import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { parseApiKeys, isProtected, createAuthHook } from "../src/auth.js";
import { loadConfig, type AppConfig } from "../src/config.js";

// Build a baseline config via loadConfig({}) (no env -> all defaults) and override
// only the auth-relevant fields. This keeps the test hermetic and avoids relying
// on the ambient process.env.
function makeConfig(overrides: Partial<AppConfig>): AppConfig {
  return { ...loadConfig({} as NodeJS.ProcessEnv), ...overrides };
}

// Minimal fake reply that captures the status code and sent body. reply.code()
// returns the reply itself so the production `reply.code(401).send(...)` chain works.
interface CapturedReply {
  reply: FastifyReply;
  statusCode: number | undefined;
  body: unknown;
  sendCalled: boolean;
}

function makeReply(): CapturedReply {
  const captured: CapturedReply = {
    reply: undefined as unknown as FastifyReply,
    statusCode: undefined,
    body: undefined,
    sendCalled: false
  };
  const reply = {
    code(status: number) {
      captured.statusCode = status;
      return reply;
    },
    send(payload: unknown) {
      captured.sendCalled = true;
      captured.body = payload;
      return reply;
    }
  };
  captured.reply = reply as unknown as FastifyReply;
  return captured;
}

// Minimal fake request shaped like the bits createAuthHook reads.
function makeRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string | string[] | undefined>;
}): FastifyRequest {
  return {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {}
  } as unknown as FastifyRequest;
}

describe("parseApiKeys", () => {
  it("returns an empty array for undefined or empty input", () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys("")).toEqual([]);
    expect(parseApiKeys("   ")).toEqual([]);
  });

  it("splits on commas and trims surrounding whitespace", () => {
    expect(parseApiKeys("k1,k2")).toEqual(["k1", "k2"]);
    expect(parseApiKeys("  k1 , k2  ")).toEqual(["k1", "k2"]);
  });

  it("splits on whitespace as well as commas and drops empties", () => {
    expect(parseApiKeys("k1 k2")).toEqual(["k1", "k2"]);
    expect(parseApiKeys("k1,,k2, ,k3")).toEqual(["k1", "k2", "k3"]);
    expect(parseApiKeys("k1,\n k2 \t k3")).toEqual(["k1", "k2", "k3"]);
  });
});

describe("isProtected", () => {
  describe('mode "off"', () => {
    it("is never protected, regardless of method or path", () => {
      expect(isProtected("GET", "/health", "off")).toBe(false);
      expect(isProtected("POST", "/scrape", "off")).toBe(false);
      expect(isProtected("DELETE", "/governance/approvals", "off")).toBe(false);
    });
  });

  describe('mode "write"', () => {
    it("protects mutating methods", () => {
      expect(isProtected("POST", "/scrape", "write")).toBe(true);
      expect(isProtected("PUT", "/scrape", "write")).toBe(true);
      expect(isProtected("PATCH", "/scrape", "write")).toBe(true);
      expect(isProtected("DELETE", "/scrape", "write")).toBe(true);
    });

    it("protects any /governance path even for GET", () => {
      expect(isProtected("GET", "/governance", "write")).toBe(true);
      expect(isProtected("GET", "/governance/approvals", "write")).toBe(true);
    });

    it("protects the governance-sensitive /audit read in write mode", () => {
      expect(isProtected("GET", "/audit", "write")).toBe(true);
    });

    it("protects /admin reads in write mode", () => {
      expect(isProtected("GET", "/admin/retention", "write")).toBe(true);
    });

    it("protects operational read routes /metrics, /events, /webhooks in write mode", () => {
      expect(isProtected("GET", "/metrics", "write")).toBe(true);
      expect(isProtected("GET", "/events", "write")).toBe(true);
      expect(isProtected("GET", "/webhooks", "write")).toBe(true);
    });

    it("does not protect GET on non-governance paths", () => {
      expect(isProtected("GET", "/scrape", "write")).toBe(false);
      expect(isProtected("GET", "/health", "write")).toBe(false);
      expect(isProtected("GET", "/search", "write")).toBe(false);
    });

    it("is case-insensitive on the method", () => {
      expect(isProtected("post", "/scrape", "write")).toBe(true);
      expect(isProtected("get", "/scrape", "write")).toBe(false);
    });
  });

  describe('mode "all"', () => {
    it("protects everything except GET /health", () => {
      expect(isProtected("GET", "/health", "all")).toBe(false);
      expect(isProtected("GET", "/scrape", "all")).toBe(true);
      expect(isProtected("POST", "/health", "all")).toBe(true);
      expect(isProtected("POST", "/scrape", "all")).toBe(true);
      expect(isProtected("GET", "/governance", "all")).toBe(true);
    });
  });
});

describe("createAuthHook", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe('authMode "write" with keys "k1,k2"', () => {
    const config = () => makeConfig({ authMode: "write", apiKeys: "k1,k2" });

    it("allows GET /health (not protected) with no key", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(makeRequest({ method: "GET", url: "/health" }), reply.reply);
      expect(reply.sendCalled).toBe(false);
      expect(reply.statusCode).toBeUndefined();
    });

    it("rejects POST /scrape without a key (401)", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(makeRequest({ method: "POST", url: "/scrape" }), reply.reply);
      expect(reply.statusCode).toBe(401);
      expect(reply.sendCalled).toBe(true);
      expect(reply.body).toMatchObject({ error: "unauthorized" });
    });

    it("allows POST /scrape with a valid Bearer authorization header", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(
        makeRequest({
          method: "POST",
          url: "/scrape",
          headers: { authorization: "Bearer k1" }
        }),
        reply.reply
      );
      expect(reply.sendCalled).toBe(false);
      expect(reply.statusCode).toBeUndefined();
    });

    it("allows POST /scrape with a valid x-api-key header", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(
        makeRequest({
          method: "POST",
          url: "/scrape",
          headers: { "x-api-key": "k2" }
        }),
        reply.reply
      );
      expect(reply.sendCalled).toBe(false);
      expect(reply.statusCode).toBeUndefined();
    });

    it("rejects POST /scrape with a wrong key (401)", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(
        makeRequest({
          method: "POST",
          url: "/scrape",
          headers: { authorization: "Bearer nope" }
        }),
        reply.reply
      );
      expect(reply.statusCode).toBe(401);
      expect(reply.sendCalled).toBe(true);
    });

    it("protects GET /metrics in write mode (401 without a key)", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(makeRequest({ method: "GET", url: "/metrics" }), reply.reply);
      expect(reply.statusCode).toBe(401);
      expect(reply.sendCalled).toBe(true);
    });

    it("allows GET /metrics with a valid key in write mode", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(makeRequest({ method: "GET", url: "/metrics", headers: { "x-api-key": "k1" } }), reply.reply);
      expect(reply.sendCalled).toBe(false);
      expect(reply.statusCode).toBeUndefined();
    });
  });

  describe("fail-closed when authMode is set but no keys are configured", () => {
    it("rejects a protected route with 503 in write mode", async () => {
      const hook = createAuthHook(makeConfig({ authMode: "write", apiKeys: undefined }));
      const reply = makeReply();
      await hook(makeRequest({ method: "POST", url: "/scrape" }), reply.reply);
      expect(reply.statusCode).toBe(503);
      expect(reply.sendCalled).toBe(true);
      expect(reply.body).toMatchObject({ error: "auth_misconfigured" });
    });

    it("rejects a protected route with 503 in all mode", async () => {
      const hook = createAuthHook(makeConfig({ authMode: "all", apiKeys: "" }));
      const reply = makeReply();
      await hook(makeRequest({ method: "GET", url: "/scrape" }), reply.reply);
      expect(reply.statusCode).toBe(503);
      expect(reply.sendCalled).toBe(true);
      expect(reply.body).toMatchObject({ error: "auth_misconfigured" });
    });

    it("still leaves GET /health open in all mode with no keys", async () => {
      const hook = createAuthHook(makeConfig({ authMode: "all", apiKeys: "" }));
      const reply = makeReply();
      await hook(makeRequest({ method: "GET", url: "/health" }), reply.reply);
      expect(reply.sendCalled).toBe(false);
      expect(reply.statusCode).toBeUndefined();
    });
  });

  describe('authMode "all" with keys "k1,k2"', () => {
    const config = () => makeConfig({ authMode: "all", apiKeys: "k1,k2" });

    it("blocks a protected route without a key (401)", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(makeRequest({ method: "GET", url: "/scrape" }), reply.reply);
      expect(reply.statusCode).toBe(401);
      expect(reply.sendCalled).toBe(true);
    });

    it("allows a protected route with a valid key", async () => {
      const hook = createAuthHook(config());
      const reply = makeReply();
      await hook(makeRequest({ method: "GET", url: "/scrape", headers: { authorization: "Bearer k2" } }), reply.reply);
      expect(reply.sendCalled).toBe(false);
      expect(reply.statusCode).toBeUndefined();
    });
  });

  describe('authMode "off"', () => {
    it("always passes, even for a protected method without a key", async () => {
      const hook = createAuthHook(makeConfig({ authMode: "off", apiKeys: "k1,k2" }));
      const reply = makeReply();
      await hook(makeRequest({ method: "POST", url: "/scrape" }), reply.reply);
      expect(reply.sendCalled).toBe(false);
      expect(reply.statusCode).toBeUndefined();
    });
  });
});
