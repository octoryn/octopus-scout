import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Hermetic, direct tests of scrapeUrl over a localhost node:http fixture.
 *
 * A node:http server bound to 127.0.0.1 (ephemeral port-0) serves a content-rich
 * HTML page (so render:"auto" never escalates to a browser render) plus an empty
 * /robots.txt. OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true is set before the module
 * under test is dynamically imported so the urlGuard's private-host check is
 * skipped for the loopback address. OCTORYN_SCOUT_DATA_DIR points at a throwaway
 * temp dir and DATABASE_URL is cleared so the filesystem snapshot store is used
 * and no Postgres connection is attempted. No external network and no chromium
 * are required.
 *
 * Dedup vs cache, as exercised here (verified against src/ingest/pipeline.ts):
 *   - cacheTtlSeconds is forced to 0 so the TTL cache lookup is skipped
 *     (`config.cacheTtlSeconds > 0` is false) and cache.hit stays false.
 *   - A first scrape stores a snapshot: cache.dedup.duplicate === false.
 *   - A second scrape WITHOUT forceRefresh re-fetches, computes the same content
 *     hash, and findByHash matches the stored snapshot, so
 *     cache.dedup.duplicate === true. This is the documented duplicate path.
 *   - NOTE: a scrape with forceRefresh:true intentionally does NOT dedup
 *     (findByHash is gated on `!request.forceRefresh`), so forceRefresh yields
 *     duplicate === false. We assert that explicitly so the contract is pinned.
 */

interface Listener {
  origin: string;
  close: () => Promise<void>;
}

// > 500 chars of visible text so render:"auto" stays static (no chromium).
const RICH_BODY = "Octopus scout pipeline hermetic fixture content body. ".repeat(40);
const NORMAL_HTML = `<!doctype html><html><head><title>Fixture</title></head><body><main><p>${RICH_BODY}</p></main></body></html>`;
// Same shape but seeded with risk keywords from evidenceBuilder's riskKeywords list.
const SENSITIVE_HTML = `<!doctype html><html><head><title>Clinic</title></head><body><main><p>This medical clinical diagnosis treatment patient guidance. ${RICH_BODY}</p></main></body></html>`;

async function startServer(): Promise<Listener | null> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("");
      return;
    }
    const html = req.url && req.url.startsWith("/sensitive") ? SENSITIVE_HTML : NORMAL_HTML;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
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

const ENV_KEYS = [
  "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
  "OCTORYN_SCOUT_DATA_DIR",
  "OCTORYN_SCOUT_CACHE_TTL_SECONDS",
  "DATABASE_URL"
] as const;

describe("scrapeUrl pipeline (hermetic localhost fixture)", () => {
  const saved: Record<string, string | undefined> = {};
  let listener: Listener | null = null;
  let dataDir: string | null = null;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    dataDir = mkdtempSync(join(tmpdir(), "scout-pipeline-"));
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    process.env.OCTORYN_SCOUT_CACHE_TTL_SECONDS = "0";
    delete process.env.DATABASE_URL;
    vi.resetModules();
  });

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = null;
    }
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = null;
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

  it("a fresh scrape returns markdown, a content hash, and dedup.duplicate === false", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const { scrapeUrl } = await import("../src/ingest/pipeline.js");
    const result = await scrapeUrl({ url: `${listener.origin}/page` });

    expect(typeof result.extraction.markdown).toBe("string");
    expect(result.extraction.markdown.length).toBeGreaterThan(0);
    expect(result.extraction.markdown).toContain("hermetic fixture");

    expect(result.evidence.contentHash).toBeTruthy();
    expect(typeof result.evidence.contentHash).toBe("string");

    expect(result.cache.hit).toBe(false);
    expect(result.cache.dedup?.duplicate).toBe(false);
  });

  it("a second scrape of identical content (no forceRefresh, TTL disabled) sets dedup.duplicate === true", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const { scrapeUrl } = await import("../src/ingest/pipeline.js");
    const url = `${listener.origin}/page`;

    const first = await scrapeUrl({ url });
    expect(first.cache.dedup?.duplicate).toBe(false);
    const firstHash = first.evidence.contentHash;

    const second = await scrapeUrl({ url });
    // Re-scrape with the same content hash hits findByHash -> marked duplicate.
    expect(second.cache.hit).toBe(false);
    expect(second.cache.dedup?.duplicate).toBe(true);
    expect(second.cache.dedup?.ofSnapshotId).toBeTruthy();
    expect(second.evidence.contentHash).toBe(firstHash);
  });

  it("forceRefresh:true intentionally bypasses dedup (duplicate === false)", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const { scrapeUrl } = await import("../src/ingest/pipeline.js");
    const url = `${listener.origin}/page`;

    await scrapeUrl({ url });
    const forced = await scrapeUrl({ url, forceRefresh: true });

    // findByHash is gated on !forceRefresh, so a forced re-scrape never dedups.
    expect(forced.cache.hit).toBe(false);
    expect(forced.cache.dedup?.duplicate).toBe(false);
  });

  it("a page with sensitive/medical terms yields governance.status === 'requires_approval'", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    const { scrapeUrl } = await import("../src/ingest/pipeline.js");
    const result = await scrapeUrl({ url: `${listener.origin}/sensitive` });

    expect(result.evidence.governance.status).toBe("requires_approval");
    expect(result.evidence.governance.reasons.length).toBeGreaterThan(0);
  });

  it("BLOCK MEANS BLOCK: a blocked page is neither served (empty body) nor persisted", async (ctx) => {
    listener = await startServer();
    if (!listener) {
      ctx.skip();
      return;
    }

    // A domain policy that blocks 127.0.0.1 escalates the decision to "blocked".
    writeFileSync(
      join(dataDir!, "policy.json"),
      JSON.stringify({ version: "test-block", domains: [{ domain: "127.0.0.1", action: "block" }] })
    );

    const { scrapeUrl } = await import("../src/ingest/pipeline.js");
    const url = `${listener.origin}/page`;
    const result = await scrapeUrl({ url });

    // Decision is blocked and the body is withheld.
    expect(result.evidence.governance.status).toBe("blocked");
    expect(result.extraction.markdown).toBe("");
    expect(result.extraction.textContent).toBe("");
    expect(result.fetch.html).toBeUndefined();

    // No snapshot was persisted (skipped store.save).
    expect(result.cache.snapshotId).toBeUndefined();
    const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
    const store = createSnapshotStore();
    await store.init();
    const versions = await store.listVersionsByUrl(result.request.url);
    expect(versions).toEqual([]);
  });
});
