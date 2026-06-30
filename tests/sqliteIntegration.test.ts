import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetSqliteDbCache } from "../src/storage/sqlite.js";

/**
 * Cross-store smoke test on the DEFAULT (SQLite) storage backend.
 *
 * Everything is hermetic: a tiny node:http server on 127.0.0.1 serves one
 * content-rich HTML page (plus an empty /robots.txt), the deterministic stub
 * embedding provider is forced (no provider keys), and the SQLite backend is
 * rooted in a fresh OS temp dir (no DATABASE_URL). We:
 *
 *   1. ingest the page  -> assert a snapshot row + indexed chunks exist and the
 *      shared `octopus-scout.db` file is actually on disk;
 *   2. search           -> assert the distinctive chunk is retrievable;
 *   3. create + reject   -> drive applyApprovalDecision and assert BOTH the
 *      snapshot (snapshotStore.getLatestByUrl undefined) AND the vector chunks
 *      were purged.
 *
 * Modules read config lazily off process.env, so env is set in beforeEach
 * BEFORE the dynamic imports inside each test; the SQLite connection cache is
 * reset so we open the temp-dir database, not a stale one.
 */

// > 500 chars of visible body text so render:"auto" stays static (no chromium),
// seeded with a unique marker so the chunk is unmistakable in lexical search.
const MARKER = `quokka-${randomUUID().slice(0, 8)}`;
const RICH_BODY =
  `This hermetic ${MARKER} fixture page describes the SQLite default storage backend smoke test. ` +
  "It is intentionally long enough for Readability to extract a meaningful article body and for the " +
  "chunker to produce at least one chunk that can be embedded, indexed, searched, and then purged. ".repeat(4);
const PAGE_HTML = `<!doctype html><html lang="en"><head><title>Fixture ${MARKER}</title></head><body><main><article><h1>Fixture ${MARKER}</h1><p>${RICH_BODY}</p></article></main></body></html>`;

interface Listener {
  origin: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<Listener | null> {
  const server: Server = createServer((req, res) => {
    if ((req.url ?? "/").split("?")[0] === "/robots.txt") {
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
  if (!bound) return null;

  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

const ENV_KEYS = [
  "OCTORYN_SCOUT_DATA_DIR",
  "OCTORYN_SCOUT_STORAGE_BACKEND",
  "OCTORYN_SCOUT_EMBEDDING_PROVIDER",
  "OCTORYN_SCOUT_CACHE_TTL_SECONDS",
  "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
  "DATABASE_URL",
  "VOYAGE_API_KEY",
  "OPENAI_API_KEY"
] as const;

describe("SQLite default backend: cross-store end-to-end smoke", () => {
  const saved: Record<string, string | undefined> = {};
  let dataDir: string;
  let listener: Listener | null = null;

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];

    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-sqlite-int-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    // Exercise the DEFAULT store explicitly.
    process.env.OCTORYN_SCOUT_STORAGE_BACKEND = "sqlite";
    // Deterministic, network-free embeddings; no provider keys.
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Skip the TTL cache so each scrape re-evaluates the fixture deterministically.
    process.env.OCTORYN_SCOUT_CACHE_TTL_SECONDS = "0";
    // The fixture is served on 127.0.0.1; opt past the SSRF private-host guard.
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    // Postgres takes precedence over everything; make sure it is not selected.
    delete process.env.DATABASE_URL;

    // Fresh connection cache so we open the temp-dir database, not a stale one.
    resetSqliteDbCache();
  });

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = null;
    }
    resetSqliteDbCache();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it(
    "ingests a page, searches it, then purges both snapshot and vectors on reject",
    { timeout: 30_000 },
    async (ctx) => {
      listener = await startServer();
      if (!listener) {
        // Could not bind a localhost socket in this sandbox; nothing to assert.
        ctx.skip();
        return;
      }

      // Import AFTER env is set so config-driven singletons bind the temp dir +
      // SQLite backend + stub provider.
      const { ingestUrl, searchKnowledge } = await import("../src/knowledge/retrieval.js");
      const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
      const { getVectorStore } = await import("../src/knowledge/vectorStore.js");
      const { getApprovalStore } = await import("../src/governance/approvalStore.js");
      const { getAuditLog } = await import("../src/governance/auditLog.js");
      const { applyApprovalDecision } = await import("../src/governance/approvalDecision.js");

      const url = `${listener.origin}/page`;

      // 1. Ingest -> chunks indexed.
      const ingest = await ingestUrl({ url });
      expect(ingest.skipped).not.toBe(true);
      expect(ingest.chunksIndexed).toBeGreaterThan(0);
      const sourceUrl = ingest.sourceUrl;

      // The shared SQLite database file is actually on disk under the data dir.
      const dbStat = await stat(join(dataDir, "octopus-scout.db"));
      expect(dbStat.isFile()).toBe(true);
      expect(dbStat.size).toBeGreaterThan(0);

      // A snapshot row exists for the url.
      const snapshotStore = createSnapshotStore();
      await snapshotStore.init();
      const latest = await snapshotStore.getLatestByUrl(sourceUrl);
      expect(latest).toBeDefined();
      expect(latest?.result.request.url).toBe(sourceUrl);

      // Vector chunks exist for the url (lexical is exact, unlike the stub embedder).
      const vectorStore = getVectorStore();
      await vectorStore.init();
      const chunkHits = await vectorStore.lexicalSearch(MARKER, 10, { url: sourceUrl });
      expect(chunkHits.length).toBeGreaterThan(0);

      // 2. Search returns the distinctive chunk.
      const search = await searchKnowledge({ query: `${MARKER} SQLite storage backend`, topK: 5 });
      expect(search.hits.length).toBeGreaterThan(0);
      expect(search.hits.some((h) => h.sourceUrl === sourceUrl)).toBe(true);

      // 3. Create an approval, reject it, and apply the decision to the durable
      //    layers. The reject path must purge BOTH the snapshot and the vectors.
      const approval = await getApprovalStore().create({
        url: sourceUrl,
        snapshotId: latest?.id,
        contentHash: ingest.contentHash,
        reasons: ["smoke-test"]
      });
      const decided = await getApprovalStore().decide(approval.id, "rejected", "tester");
      expect(decided?.status).toBe("rejected");

      const effect = await applyApprovalDecision(decided!, "rejected", {
        vectorStore,
        snapshotStore,
        ingestUrl: (input) => ingestUrl(input),
        recordAudit: (event) => getAuditLog().record(event)
      });
      expect(effect.error).toBeUndefined();
      expect(effect.purged).toBe(true);

      // Snapshot purged.
      expect(await snapshotStore.getLatestByUrl(sourceUrl)).toBeUndefined();
      expect(await snapshotStore.listVersionsByUrl(sourceUrl)).toEqual([]);

      // Vector chunks purged.
      const afterHits = await vectorStore.lexicalSearch(MARKER, 10, { url: sourceUrl });
      expect(afterHits).toEqual([]);
      const afterSearch = await searchKnowledge({ query: `${MARKER} SQLite storage backend`, topK: 5 });
      expect(afterSearch.hits.some((h) => h.sourceUrl === sourceUrl)).toBe(false);
    }
  );
});
