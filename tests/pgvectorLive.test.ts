import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { StoredChunk } from "../src/types.js";

/**
 * DB-gated pgvector integration test. Runs only when OCTORYN_TEST_PG_URL points
 * at a Postgres with the `vector` extension; otherwise SKIPS (CI-safe).
 *
 *   OCTORYN_TEST_PG_URL=postgres://octoryn:octoryn@127.0.0.1:5433/octopus_scout \
 *     npx vitest run tests/pgvectorLive.test.ts
 *
 * Regression guard: a search-only process (one that never upserts) must still
 * see rows written by another process — i.e. search must not depend on the
 * in-memory `tableReady` flag.
 */

const PG = process.env.OCTORYN_TEST_PG_URL;

function chunk(documentId: string, sourceUrl: string, dim: number): StoredChunk {
  const embedding = Array.from({ length: dim }, (_, i) => Math.sin(i + 1) * 0.1);
  return {
    chunkId: `${documentId}-0`,
    documentId,
    sourceUrl,
    finalUrl: sourceUrl,
    title: "Live PG fixture",
    contentHash: documentId,
    index: 0,
    content: "pgvector regression fixture content",
    headingPath: [],
    governanceStatus: "allowed",
    trustScore: 0.6,
    capturedAt: new Date().toISOString(),
    embedding
  };
}

describe.skipIf(!PG)("pgvector (live DB)", () => {
  const url = `https://pgvec.test/${randomUUID().slice(0, 8)}`;
  const docId = `doc-${randomUUID().slice(0, 8)}`;
  const dim = 256;

  afterAll(async () => {
    process.env.DATABASE_URL = PG;
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    vi.resetModules();
    const { getVectorStore } = await import("../src/knowledge/vectorStore.js");
    await getVectorStore()
      .deleteByUrl(url)
      .catch(() => undefined);
  });

  it("a fresh search-only store sees rows written by another store instance", { timeout: 30_000 }, async () => {
    process.env.DATABASE_URL = PG;
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";

    // Writer "process": upsert one chunk.
    vi.resetModules();
    const writer = (await import("../src/knowledge/vectorStore.js")).getVectorStore();
    await writer.init();
    await writer.upsertChunks([chunk(docId, url, dim)]);

    // Reader "process": brand-new module graph + store, never upserts.
    vi.resetModules();
    const reader = (await import("../src/knowledge/vectorStore.js")).getVectorStore();
    const queryVec = Array.from({ length: dim }, (_, i) => Math.sin(i + 1) * 0.1);
    const hits = await reader.search(queryVec, 5, { url });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sourceUrl).toBe(url);
    expect(Number.isFinite(hits[0].score)).toBe(true);
  });

  it("applies governance filters, lexical search, updates, and delete", { timeout: 30_000 }, async () => {
    process.env.DATABASE_URL = PG;
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    process.env.OCTORYN_SCOUT_VECTOR_DIM = String(dim);

    vi.resetModules();
    const store = (await import("../src/knowledge/vectorStore.js")).getVectorStore();
    await store.init();
    await store.upsertChunks([
      {
        ...chunk(`${docId}-filters`, `${url}/filters`, dim),
        content: "alpha pgvector lexical governance fixture",
        trustScore: 0.9
      }
    ]);

    expect((await store.lexicalSearch("alpha governance", 5, { url: `${url}/filters` })).length).toBeGreaterThan(0);
    expect(await store.setGovernanceStatusByUrl(`${url}/filters`, "denied")).toBeGreaterThan(0);
    expect(
      await store.search(
        Array.from({ length: dim }, (_, i) => Math.sin(i + 1) * 0.1),
        5,
        { url: `${url}/filters` }
      )
    ).toHaveLength(0);
    expect(
      await store.search(
        Array.from({ length: dim }, (_, i) => Math.sin(i + 1) * 0.1),
        5,
        {
          url: `${url}/filters`,
          includeUnapproved: true
        }
      )
    ).toHaveLength(1);
    await store.deleteByUrl(`${url}/filters`);
    expect(
      await store.lexicalSearch("alpha governance", 5, { url: `${url}/filters`, includeUnapproved: true })
    ).toHaveLength(0);
  });
});
