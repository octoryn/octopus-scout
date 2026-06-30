import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { StoredChunk, VectorStore } from "../src/types.js";

// Build a StoredChunk with sensible defaults. The embedding is required by the
// StoredChunk shape (and the file backend only persists lines that carry one),
// but lexical search ignores it — BM25 scores `content` alone.
function makeChunk(overrides: Partial<StoredChunk> & Pick<StoredChunk, "chunkId" | "content">): StoredChunk {
  return {
    documentId: overrides.documentId ?? `doc-${overrides.chunkId}`,
    sourceUrl: overrides.sourceUrl ?? `https://example.com/${overrides.chunkId}`,
    finalUrl: overrides.finalUrl ?? overrides.sourceUrl ?? `https://example.com/${overrides.chunkId}`,
    contentHash: overrides.contentHash ?? `hash-${overrides.chunkId}`,
    index: overrides.index ?? 0,
    headingPath: overrides.headingPath ?? [],
    governanceStatus: overrides.governanceStatus ?? "allowed",
    trustScore: overrides.trustScore ?? 1,
    capturedAt: overrides.capturedAt ?? "2026-06-30T00:00:00.000Z",
    embedding: overrides.embedding ?? [0.1, 0.2, 0.3],
    ...overrides
  };
}

describe("FileVectorStore lexicalSearch via getVectorStore", () => {
  let dataDir: string;
  let store: VectorStore;

  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    // Unique temp dir per test -> hermetic, no cross-test bleed.
    dataDir = await mkdtemp(join(tmpdir(), `octopus-scout-lexical-${randomUUID()}-`));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    // Force the file backend: any ambient DATABASE_URL would select Postgres.
    delete process.env.DATABASE_URL;

    // getVectorStore() memoizes a process-wide singleton that reads config at
    // construction; reset modules so the fresh import picks up our temp dir.
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

  const photosynthesis = makeChunk({
    chunkId: "bio-1",
    sourceUrl: "https://science.example.com/biology",
    content:
      "Photosynthesis uses chlorophyll in plant chloroplasts to convert light into chemical energy. " +
      "The chlorophyll pigment absorbs light energy that drives the photosynthesis reaction."
  });
  const espresso = makeChunk({
    chunkId: "coffee-1",
    sourceUrl: "https://coffee.example.com/brewing",
    content:
      "A well-pulled espresso shot is topped with a thick golden crema. " +
      "Baristas judge espresso quality by the crema's color and persistence."
  });
  const revenue = makeChunk({
    chunkId: "finance-1",
    sourceUrl: "https://finance.example.com/earnings",
    content:
      "Quarterly revenue rose as the company reported strong earnings for the fiscal quarter. " +
      "Revenue growth outpaced analyst expectations this quarter."
  });

  it("ranks the photosynthesis chunk first for a topical query", async () => {
    await store.upsertChunks([photosynthesis, espresso, revenue]);

    const hits = await store.lexicalSearch("chlorophyll energy", 3);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkId).toBe("bio-1");
    // Scores are sorted descending and strictly positive (BM25 drops zeros).
    expect(hits[0]?.score).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    // Hits omit the embedding (projected into a VectorSearchHit).
    expect((hits[0] as unknown as Record<string, unknown>).embedding).toBeUndefined();
  });

  it("respects topK by capping the number of returned hits", async () => {
    await store.upsertChunks([photosynthesis, espresso, revenue]);

    const hits = await store.lexicalSearch("revenue quarter earnings", 1);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunkId).toBe("finance-1");
  });

  it("restricts results with filter.url", async () => {
    await store.upsertChunks([photosynthesis, espresso, revenue]);

    // Query terms appear in multiple chunks, but the url filter pins the corpus.
    const hits = await store.lexicalSearch("quality energy quarter", 3, {
      url: "https://coffee.example.com/brewing"
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.sourceUrl).toBe("https://coffee.example.com/brewing");
      expect(hit.chunkId).toBe("coffee-1");
    }
  });

  it("returns [] for an empty corpus", async () => {
    const hits = await store.lexicalSearch("anything at all", 3);
    expect(hits).toEqual([]);
  });

  it("returns [] when no chunk matches the query", async () => {
    await store.upsertChunks([photosynthesis, espresso, revenue]);

    const hits = await store.lexicalSearch("xylophone zeppelin quokka", 3);
    expect(hits).toEqual([]);
  });

  it("excludes requires_approval / blocked by default; includeUnapproved admits only requires_approval", async () => {
    const allowed = makeChunk({
      chunkId: "allowed-1",
      content: "Quarterly revenue rose with strong earnings this quarter."
    });
    const pending = makeChunk({
      chunkId: "pending-1",
      governanceStatus: "requires_approval",
      content: "Quarterly revenue and earnings figures pending compliance approval this quarter."
    });
    const blocked = makeChunk({
      chunkId: "blocked-1",
      governanceStatus: "blocked",
      content: "Quarterly revenue and earnings disclosed despite a block this quarter."
    });
    await store.upsertChunks([allowed, pending, blocked]);

    const defaultHits = await store.lexicalSearch("revenue earnings quarter", 10);
    expect(defaultHits.map((h) => h.chunkId)).toEqual(["allowed-1"]);

    const withUnapproved = await store.lexicalSearch("revenue earnings quarter", 10, { includeUnapproved: true });
    const ids = withUnapproved.map((h) => h.chunkId).sort();
    expect(ids).toEqual(["allowed-1", "pending-1"]);
    expect(ids).not.toContain("blocked-1");
  });
});
