import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtractionStore, schemaHash, type ExtractionStore } from "../src/extract/extractionStore.js";
import { resetSqliteDbCache } from "../src/storage/sqlite.js";
import type { GovernanceDecision, StoredExtraction } from "../src/types.js";

/**
 * Build a type-complete StoredExtraction. Only the fields the store reads
 * (id, sourceUrl, schemaHash, contentHash, governanceStatus, createdAt) need to
 * be meaningful; `data`/`provider` are filler.
 */
function makeExtraction(
  url: string,
  status: GovernanceDecision["status"],
  createdAt: string,
  data: Record<string, unknown> = { title: "x" }
): StoredExtraction {
  return {
    id: randomUUID(),
    sourceUrl: url,
    finalUrl: url,
    provider: "none",
    data,
    governanceStatus: status,
    schemaHash: schemaHash({ type: "object" }),
    contentHash: "hash-aaa",
    createdAt
  };
}

/**
 * The two hermetic backends are exercised by the SAME suite via a table-driven
 * `describe.each`: "file" forces OCTORYN_SCOUT_STORAGE_BACKEND=file, "sqlite"
 * forces =sqlite and resets the connection cache before each test.
 */
describe.each(["file", "sqlite"] as const)("ExtractionStore (%s backend)", (backend) => {
  let dataDir: string;
  let store: ExtractionStore;
  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousBackend = process.env.OCTORYN_SCOUT_STORAGE_BACKEND;
  const url = `https://example.com/page-${randomUUID()}`;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), `octopus-scout-extract-${backend}-`));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    process.env.OCTORYN_SCOUT_STORAGE_BACKEND = backend;
    // Postgres takes precedence over everything; make sure it is not selected.
    delete process.env.DATABASE_URL;
    resetSqliteDbCache();
    store = createExtractionStore();
    await store.init();
  });

  afterEach(async () => {
    resetSqliteDbCache();
    if (previousDataDir === undefined) delete process.env.OCTORYN_SCOUT_DATA_DIR;
    else process.env.OCTORYN_SCOUT_DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousBackend === undefined) delete process.env.OCTORYN_SCOUT_STORAGE_BACKEND;
    else process.env.OCTORYN_SCOUT_STORAGE_BACKEND = previousBackend;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("save then getById round-trips the full record", async () => {
    const rec = makeExtraction(url, "allowed", "2026-06-30T00:00:00.000Z", { title: "Hello" });
    const saved = await store.save(rec);
    expect(saved.id).toBe(rec.id);

    const fetched = await store.getById(rec.id);
    expect(fetched).toBeDefined();
    expect(fetched?.sourceUrl).toBe(url);
    expect(fetched?.data).toEqual({ title: "Hello" });
    expect(fetched?.schemaHash).toBe(rec.schemaHash);
    expect(fetched?.governanceStatus).toBe("allowed");
  });

  it("getById returns undefined for an unknown id", async () => {
    expect(await store.getById(randomUUID())).toBeUndefined();
  });

  it("listByUrl returns allowed extractions newest-first", async () => {
    await store.save(makeExtraction(url, "allowed", "2026-06-30T00:00:00.000Z", { v: 1 }));
    await store.save(makeExtraction(url, "allowed", "2026-06-30T00:01:00.000Z", { v: 2 }));

    const list = await store.listByUrl(url);
    expect(list).toHaveLength(2);
    expect(list[0].data).toEqual({ v: 2 });
    expect(list[1].data).toEqual({ v: 1 });
  });

  it("listByUrl excludes requires_approval by default", async () => {
    await store.save(makeExtraction(url, "allowed", "2026-06-30T00:00:00.000Z"));
    await store.save(makeExtraction(url, "requires_approval", "2026-06-30T00:01:00.000Z"));

    const list = await store.listByUrl(url);
    expect(list).toHaveLength(1);
    expect(list[0].governanceStatus).toBe("allowed");
  });

  it("list() excludes requires_approval by default and surfaces it with includeUnapproved", async () => {
    await store.save(makeExtraction(url, "allowed", "2026-06-30T00:00:00.000Z"));
    await store.save(makeExtraction(url, "requires_approval", "2026-06-30T00:01:00.000Z"));

    const defaultList = await store.list();
    expect(defaultList.map((r) => r.governanceStatus)).toEqual(["allowed"]);

    const withUnapproved = await store.list(100, { includeUnapproved: true });
    const statuses = withUnapproved.map((r) => r.governanceStatus).sort();
    expect(statuses).toEqual(["allowed", "requires_approval"]);
  });

  it("never returns blocked extractions, even with includeUnapproved", async () => {
    await store.save(makeExtraction(url, "allowed", "2026-06-30T00:00:00.000Z"));
    await store.save(makeExtraction(url, "blocked", "2026-06-30T00:01:00.000Z"));

    expect((await store.list(100, { includeUnapproved: true })).map((r) => r.governanceStatus)).toEqual(["allowed"]);
    expect(await store.listByUrl(url)).toHaveLength(1);
  });

  it("deleteByUrl removes every extraction for the url and returns the count", async () => {
    await store.save(makeExtraction(url, "allowed", "2026-06-30T00:00:00.000Z"));
    await store.save(makeExtraction(url, "requires_approval", "2026-06-30T00:01:00.000Z"));

    const removed = await store.deleteByUrl(url);
    expect(removed).toBe(2);
    expect(await store.listByUrl(url)).toHaveLength(0);
    expect(await store.list(100, { includeUnapproved: true })).toHaveLength(0);
  });
});

describe("schemaHash", () => {
  it("is stable regardless of key order and changes with content", () => {
    const a = schemaHash({ a: 1, b: { c: 2, d: 3 } });
    const b = schemaHash({ b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
    expect(schemaHash({ a: 1 })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
