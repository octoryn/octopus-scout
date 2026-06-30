import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredChunk, VectorStore } from "../src/types.js";

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

describe("FileVectorStore via getVectorStore", () => {
  let dataDir: string;
  let store: VectorStore;
  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    // Hermetic file-backed store under a unique OS temp dir.
    dataDir = await mkdtemp(join(tmpdir(), `octopus-scout-vec-${randomUUID()}-`));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    // Force the file backend regardless of the ambient environment.
    delete process.env.DATABASE_URL;

    // getVectorStore() memoizes a process-wide singleton; reset the module so
    // each test gets a fresh store bound to its own temp dir.
    vi.resetModules();
    const mod = await import("../src/knowledge/vectorStore.js");
    store = mod.getVectorStore();
    await store.init();
  });

  afterEach(async () => {
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
    await rm(dataDir, { recursive: true, force: true });
  });

  it("search returns nearest-by-cosine, ordered descending", async () => {
    // Three near-orthogonal basis-ish vectors. A query aligned with the
    // x-axis must rank the x-aligned chunk first.
    await store.upsertChunks([
      makeChunk({ chunkId: "x", embedding: [1, 0, 0] }),
      makeChunk({ chunkId: "y", embedding: [0, 1, 0] }),
      makeChunk({ chunkId: "xy", embedding: [0.9, 0.1, 0] })
    ]);

    const hits = await store.search([1, 0, 0], 3);
    expect(hits.map((h) => h.chunkId)).toEqual(["x", "xy", "y"]);
    // Exact alignment -> score 1; orthogonal -> score 0.
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[2].score).toBeCloseTo(0, 5);
    // Strictly descending.
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[1].score).toBeGreaterThan(hits[2].score);
  });

  it("respects topK", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "x", embedding: [1, 0, 0] }),
      makeChunk({ chunkId: "y", embedding: [0, 1, 0] }),
      makeChunk({ chunkId: "xy", embedding: [0.9, 0.1, 0] })
    ]);
    const hits = await store.search([1, 0, 0], 2);
    expect(hits.map((h) => h.chunkId)).toEqual(["x", "xy"]);
  });

  it("filter.url restricts results to a single source", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "a", embedding: [1, 0, 0], sourceUrl: "https://a.example/doc", documentId: "doc-a" }),
      makeChunk({ chunkId: "b", embedding: [1, 0, 0], sourceUrl: "https://b.example/doc", documentId: "doc-b" })
    ]);
    const hits = await store.search([1, 0, 0], 10, { url: "https://a.example/doc" });
    expect(hits.map((h) => h.chunkId)).toEqual(["a"]);
    expect(hits[0].sourceUrl).toBe("https://a.example/doc");
  });

  it("filter.minTrust drops low-trust chunks", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "high", embedding: [1, 0, 0], trustScore: 0.9, documentId: "doc-h" }),
      makeChunk({ chunkId: "low", embedding: [1, 0, 0], trustScore: 0.2, documentId: "doc-l" })
    ]);
    const hits = await store.search([1, 0, 0], 10, { minTrust: 0.5 });
    expect(hits.map((h) => h.chunkId)).toEqual(["high"]);
  });

  it("drops governanceStatus=blocked by default but keeps it with includeBlocked", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "ok", embedding: [1, 0, 0], governanceStatus: "allowed", documentId: "doc-ok" }),
      makeChunk({ chunkId: "bad", embedding: [1, 0, 0], governanceStatus: "blocked", documentId: "doc-bad" })
    ]);

    const defaultHits = await store.search([1, 0, 0], 10);
    expect(defaultHits.map((h) => h.chunkId)).toEqual(["ok"]);

    const withBlocked = await store.search([1, 0, 0], 10, { includeBlocked: true });
    expect(withBlocked.map((h) => h.chunkId).sort()).toEqual(["bad", "ok"]);
  });

  it("excludes requires_approval by default (secure-by-default) and re-admits it with includeUnapproved", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "ok", embedding: [1, 0, 0], governanceStatus: "allowed", documentId: "doc-ok" }),
      makeChunk({
        chunkId: "pending",
        embedding: [1, 0, 0],
        governanceStatus: "requires_approval",
        documentId: "doc-pending"
      })
    ]);

    // Default: only allowed chunks are searchable.
    const defaultHits = await store.search([1, 0, 0], 10);
    expect(defaultHits.map((h) => h.chunkId)).toEqual(["ok"]);

    // includeUnapproved re-admits requires_approval.
    const withUnapproved = await store.search([1, 0, 0], 10, { includeUnapproved: true });
    expect(withUnapproved.map((h) => h.chunkId).sort()).toEqual(["ok", "pending"]);

    // includeUnapproved must NOT pull in blocked content.
    await store.upsertChunks([
      makeChunk({ chunkId: "bad", embedding: [1, 0, 0], governanceStatus: "blocked", documentId: "doc-bad" })
    ]);
    const stillNoBlocked = await store.search([1, 0, 0], 10, { includeUnapproved: true });
    expect(stillNoBlocked.map((h) => h.chunkId)).not.toContain("bad");
  });

  it("setGovernanceStatusByUrl releases requires_approval -> allowed (approve has teeth)", async () => {
    await store.upsertChunks([
      makeChunk({
        chunkId: "p1",
        embedding: [1, 0, 0],
        sourceUrl: "https://approve.example/doc",
        governanceStatus: "requires_approval",
        documentId: "doc-p"
      })
    ]);

    // Not searchable while pending.
    expect((await store.search([1, 0, 0], 10)).map((h) => h.chunkId)).toEqual([]);

    const updated = await store.setGovernanceStatusByUrl("https://approve.example/doc", "allowed");
    expect(updated).toBe(1);

    // Now searchable by default.
    expect((await store.search([1, 0, 0], 10)).map((h) => h.chunkId)).toEqual(["p1"]);
  });

  it("deleteByUrl removes all chunks for a source", async () => {
    await store.upsertChunks([
      makeChunk({ chunkId: "a", embedding: [1, 0, 0], sourceUrl: "https://a.example/doc", documentId: "doc-a" }),
      makeChunk({ chunkId: "b", embedding: [1, 0, 0], sourceUrl: "https://b.example/doc", documentId: "doc-b" })
    ]);

    await store.deleteByUrl("https://a.example/doc");

    const hits = await store.search([1, 0, 0], 10, { includeBlocked: true });
    expect(hits.map((h) => h.chunkId)).toEqual(["b"]);
  });

  it("upsert re-ingest of the same document replaces its prior chunks", async () => {
    await store.upsertChunks([makeChunk({ chunkId: "v1", embedding: [1, 0, 0], documentId: "doc" })]);
    await store.upsertChunks([makeChunk({ chunkId: "v2", embedding: [1, 0, 0], documentId: "doc" })]);

    const hits = await store.search([1, 0, 0], 10);
    expect(hits.map((h) => h.chunkId)).toEqual(["v2"]);
  });
});

describe("cosineSimilarity", () => {
  let cosineSimilarity: (a: number[], b: number[]) => number;

  beforeEach(async () => {
    const mod = await import("../src/knowledge/vectorStore.js");
    cosineSimilarity = mod.cosineSimilarity;
  });

  it("returns 1 for identical (parallel) vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    // Scale-invariant: same direction, different magnitude.
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 when either vector is the zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
