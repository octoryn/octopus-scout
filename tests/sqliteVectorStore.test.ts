import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredChunk, VectorStore } from "../src/types.js";
import { resetSqliteDbCache } from "../src/storage/sqlite.js";

/**
 * Build a type-complete StoredChunk. `embedding` and the governance/trust
 * fields are the only knobs the tests vary; everything else is filler.
 */
function makeChunk(overrides: Partial<StoredChunk> & Pick<StoredChunk, "chunkId" | "embedding">): StoredChunk {
  const base: StoredChunk = {
    chunkId: overrides.chunkId,
    documentId: overrides.documentId ?? overrides.chunkId,
    sourceUrl: "https://example.com/doc",
    finalUrl: "https://example.com/doc",
    title: "Doc",
    contentHash: `hash-${overrides.chunkId}`,
    index: 0,
    content: `content ${overrides.chunkId}`,
    headingPath: [],
    governanceStatus: "allowed",
    trustScore: 0.8,
    capturedAt: "2026-06-30T00:00:00.000Z",
    embedding: overrides.embedding
  };
  return { ...base, ...overrides };
}

describe("SqliteVectorStore via getVectorStore", () => {
  let dataDir: string;
  let store: VectorStore;
  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousBackend = process.env.OCTORYN_SCOUT_STORAGE_BACKEND;

  beforeEach(async () => {
    // Hermetic SQLite store under a unique OS temp dir.
    dataDir = await mkdtemp(join(tmpdir(), `octopus-scout-sqlite-vec-${randomUUID()}-`));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    process.env.OCTORYN_SCOUT_STORAGE_BACKEND = "sqlite";
    // No DATABASE_URL -> the sqlite backend is selected over postgres.
    delete process.env.DATABASE_URL;

    // Fresh shared DB connection for this test's temp dir.
    resetSqliteDbCache();

    // getVectorStore() memoizes a process-wide singleton; reset the module so
    // each test gets a fresh store bound to its own temp dir.
    vi.resetModules();
    const mod = await import("../src/knowledge/vectorStore.js");
    store = mod.getVectorStore();
    await store.init();
  });

  afterEach(async () => {
    resetSqliteDbCache();
    if (previousDataDir === undefined) {
      delete process.env.OCTORYN_SCOUT_DATA_DIR;
    } else {
      process.env.OCTORYN_SCOUT_DATA_DIR = previousDataDir;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousBackend === undefined) {
      delete process.env.OCTORYN_SCOUT_STORAGE_BACKEND;
    } else {
      process.env.OCTORYN_SCOUT_STORAGE_BACKEND = previousBackend;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persists and round-trips StoredChunk fields with finite scores", async () => {
    await store.upsertChunks([
      makeChunk({
        chunkId: "c1",
        embedding: [0.1, 0.2, 0.3],
        title: "Round Trip",
        headingPath: ["A", "B"],
        anchorId: "sec-1",
        index: 7,
        contentHash: "deadbeef",
        sourceUrl: "https://example.com/rt",
        finalUrl: "https://example.com/rt/final"
      })
    ]);

    const hits = await store.search([0.1, 0.2, 0.3], 5);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit.chunkId).toBe("c1");
    expect(hit.documentId).toBe("c1");
    expect(hit.title).toBe("Round Trip");
    expect(hit.headingPath).toEqual(["A", "B"]);
    expect(hit.anchorId).toBe("sec-1");
    expect(hit.contentHash).toBe("deadbeef");
    expect(hit.sourceUrl).toBe("https://example.com/rt");
    expect(hit.finalUrl).toBe("https://example.com/rt/final");
    expect(hit.governanceStatus).toBe("allowed");
    expect(hit.trustScore).toBeCloseTo(0.8, 5);
    expect(Number.isFinite(hit.score)).toBe(true);
  });

  it("respects topK", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "x", embedding: [1, 0, 0] }),
      makeChunk({ chunkId: "y", embedding: [0, 1, 0] }),
      makeChunk({ chunkId: "z", embedding: [0, 0, 1] })
    ]);
    const hits = await store.search([1, 0, 0], 2);
    expect(hits).toHaveLength(2);
  });

  it("excludes requires_approval by default", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "ok", embedding: [1, 0, 0], governanceStatus: "allowed" }),
      makeChunk({
        chunkId: "pending",
        documentId: "pending",
        sourceUrl: "https://example.com/pending",
        embedding: [1, 0, 0],
        governanceStatus: "requires_approval"
      })
    ]);
    const hits = await store.search([1, 0, 0], 10);
    expect(hits.map((h) => h.chunkId)).toEqual(["ok"]);
  });

  it("includeUnapproved admits requires_approval but not blocked", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "ok", embedding: [1, 0, 0], governanceStatus: "allowed" }),
      makeChunk({
        chunkId: "pending",
        documentId: "pending",
        sourceUrl: "https://example.com/pending",
        embedding: [1, 0, 0],
        governanceStatus: "requires_approval"
      }),
      makeChunk({
        chunkId: "blocked",
        documentId: "blocked",
        sourceUrl: "https://example.com/blocked",
        embedding: [1, 0, 0],
        governanceStatus: "blocked"
      })
    ]);
    const hits = await store.search([1, 0, 0], 10, { includeUnapproved: true });
    const ids = new Set(hits.map((h) => h.chunkId));
    expect(ids.has("ok")).toBe(true);
    expect(ids.has("pending")).toBe(true);
    expect(ids.has("blocked")).toBe(false);
  });

  it("includeBlocked admits blocked chunks", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "ok", embedding: [1, 0, 0], governanceStatus: "allowed" }),
      makeChunk({
        chunkId: "blocked",
        documentId: "blocked",
        sourceUrl: "https://example.com/blocked",
        embedding: [1, 0, 0],
        governanceStatus: "blocked"
      })
    ]);
    const hits = await store.search([1, 0, 0], 10, { includeBlocked: true });
    const ids = new Set(hits.map((h) => h.chunkId));
    expect(ids.has("ok")).toBe(true);
    expect(ids.has("blocked")).toBe(true);
  });

  it("honors minTrust and url filters", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "low", embedding: [1, 0, 0], trustScore: 0.2, sourceUrl: "https://a.com" }),
      makeChunk({
        chunkId: "high",
        documentId: "high",
        embedding: [1, 0, 0],
        trustScore: 0.9,
        sourceUrl: "https://b.com"
      })
    ]);
    const byTrust = await store.search([1, 0, 0], 10, { minTrust: 0.5 });
    expect(byTrust.map((h) => h.chunkId)).toEqual(["high"]);
    const byUrl = await store.search([1, 0, 0], 10, { url: "https://a.com" });
    expect(byUrl.map((h) => h.chunkId)).toEqual(["low"]);
  });

  it("setGovernanceStatusByUrl releases pending -> allowed so it becomes searchable", async () => {
    await store.upsertChunks([
      makeChunk({
        chunkId: "pending",
        sourceUrl: "https://example.com/release",
        embedding: [1, 0, 0],
        governanceStatus: "requires_approval"
      })
    ]);
    // Hidden by default before release.
    expect(await store.search([1, 0, 0], 10)).toHaveLength(0);

    const updated = await store.setGovernanceStatusByUrl("https://example.com/release", "allowed");
    expect(updated).toBe(1);

    const hits = await store.search([1, 0, 0], 10);
    expect(hits.map((h) => h.chunkId)).toEqual(["pending"]);
  });

  it("deleteByUrl purges from BOTH vector and lexical indexes", async () => {
    await store.upsertChunks([
      makeChunk({
        chunkId: "doomed",
        sourceUrl: "https://example.com/doomed",
        embedding: [1, 0, 0],
        content: "elephants roam the savanna freely"
      })
    ]);
    expect(await store.search([1, 0, 0], 10)).toHaveLength(1);
    expect(await store.lexicalSearch("elephants", 10)).toHaveLength(1);

    await store.deleteByUrl("https://example.com/doomed");

    expect(await store.search([1, 0, 0], 10)).toHaveLength(0);
    expect(await store.lexicalSearch("elephants", 10)).toHaveLength(0);
  });

  it("lexicalSearch finds a keyword and applies governance filter", async () => {
    await store.upsertChunks([
      makeChunk({
        chunkId: "match",
        sourceUrl: "https://example.com/match",
        embedding: [1, 0, 0],
        content: "the quick brown fox jumps over the lazy dog"
      }),
      makeChunk({
        chunkId: "noise",
        documentId: "noise",
        sourceUrl: "https://example.com/noise",
        embedding: [0, 1, 0],
        content: "completely unrelated marine biology text"
      }),
      makeChunk({
        chunkId: "pending",
        documentId: "pending",
        sourceUrl: "https://example.com/pending",
        embedding: [0, 0, 1],
        content: "the quick brown fox is pending approval",
        governanceStatus: "requires_approval"
      })
    ]);

    const hits = await store.lexicalSearch("brown fox", 10);
    const ids = hits.map((h) => h.chunkId);
    expect(ids).toContain("match");
    expect(ids).not.toContain("noise");
    // requires_approval excluded by default even when it matches the keyword.
    expect(ids).not.toContain("pending");
    for (const hit of hits) expect(Number.isFinite(hit.score)).toBe(true);

    // includeUnapproved re-admits the pending match.
    const withPending = await store.lexicalSearch("brown fox", 10, { includeUnapproved: true });
    expect(withPending.map((h) => h.chunkId)).toContain("pending");
  });

  it("upsert replaces all chunks for a re-ingested document", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "d1-a", documentId: "d1", embedding: [1, 0, 0], content: "alpha original" }),
      makeChunk({ chunkId: "d1-b", documentId: "d1", embedding: [0, 1, 0], content: "beta original" })
    ]);
    // Re-ingest the document with a single, different chunk.
    await store.upsertChunks([
      makeChunk({ chunkId: "d1-c", documentId: "d1", embedding: [0, 0, 1], content: "gamma fresh" })
    ]);

    const hits = await store.search([0, 0, 1], 10, { includeUnapproved: true, includeBlocked: true });
    expect(hits.map((h) => h.chunkId)).toEqual(["d1-c"]);
    // Stale FTS rows for the replaced chunks must be gone too.
    expect(await store.lexicalSearch("original", 10)).toHaveLength(0);
    expect((await store.lexicalSearch("gamma", 10)).map((h) => h.chunkId)).toEqual(["d1-c"]);
  });
});
