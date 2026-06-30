import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Hermetic tests for the LocalFetchProvider static path.
 *
 * A node:http server bound to 127.0.0.1 (ephemeral port-0) serves a content-rich
 * HTML page plus an empty /robots.txt. OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true is
 * set before the module under test is dynamically imported so the urlGuard's
 * private-host check is skipped for the loopback address. No external network and
 * no chromium are required for the static fetch path.
 */

interface Listener {
  origin: string;
  close: () => Promise<void>;
}

// A page with > 500 chars of visible text so render:"auto" never escalates to a
// browser render (shouldRender returns false on content-rich HTML).
const RICH_BODY = "Octopus scout fetch provider hermetic fixture. ".repeat(40);
const PAGE_HTML = `<!doctype html><html><head><title>Fixture</title></head><body><main><p>${RICH_BODY}</p></main></body></html>`;

async function startServer(): Promise<Listener | null> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

const ENV_KEYS = ["OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS", "OCTORYN_SCOUT_FETCH_PROVIDER"] as const;

describe("getFetchProvider / LocalFetchProvider static path", () => {
  const saved: Record<string, string | undefined> = {};
  let listener: Listener | null = null;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    vi.resetModules();
  });

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = null;
    }
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("returns the local provider (name 'local')", async () => {
    const { getFetchProvider } = await import("../src/fetcher/fetchProvider.js");
    const provider = getFetchProvider();
    expect(provider.name).toBe("local");
  });

  it("fetch(url, { render: 'static' }) returns an unrendered local resource with the served body", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const { getFetchProvider } = await import("../src/fetcher/fetchProvider.js");
    const provider = getFetchProvider();

    const result = await provider.fetch(`${listener.origin}/`, { render: "static" });

    expect(result.rendered).toBe(false);
    expect(result.provider).toBe("local");
    expect(result.resource.ok).toBe(true);
    expect(result.resource.status).toBe(200);
    expect(result.resource.contentType).toContain("html");
    expect(result.resource.body.toString("utf8")).toContain("hermetic fixture");
  });

  it("render: 'auto' on a content-rich page stays static (rendered: false)", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const { getFetchProvider } = await import("../src/fetcher/fetchProvider.js");
    const provider = getFetchProvider();

    const result = await provider.fetch(`${listener.origin}/`, { render: "auto" });

    expect(result.rendered).toBe(false);
    expect(result.provider).toBe("local");
    expect(result.resource.ok).toBe(true);
    expect(result.resource.body.toString("utf8")).toContain("hermetic fixture");
  });
});
