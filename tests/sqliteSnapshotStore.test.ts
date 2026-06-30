import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotStore, type SnapshotStore } from "../src/storage/snapshotStore.js";
import { resetSqliteDbCache } from "../src/storage/sqlite.js";
import type { ScrapeResult } from "../src/types.js";

/**
 * Build a minimal but type-complete ScrapeResult for a given url + contentHash.
 * Only the fields the snapshot store reads (url, finalUrl, contentHash,
 * extraction.title, evidence.governance.status) need to be meaningful.
 */
function makeResult(url: string, contentHash: string, title: string): ScrapeResult {
  const finalUrl = url;
  return {
    request: {
      url,
      render: "auto",
      respectRobots: true,
      forceRefresh: false,
      includeHtml: false,
      includeScreenshot: false
    },
    fetch: {
      url,
      finalUrl,
      status: 200,
      ok: true,
      contentType: "text/html",
      fetchedAt: new Date().toISOString(),
      elapsedMs: 1,
      rendered: false
    },
    extraction: {
      kind: "html",
      title,
      textContent: "body text",
      markdown: "body text",
      links: [],
      images: [],
      tables: [],
      metadata: {}
    },
    evidence: {
      sourceUrl: url,
      finalUrl,
      capturedAt: new Date().toISOString(),
      contentHash,
      anchors: [],
      trust: { score: 0.8, label: "high", reasons: [] },
      governance: { status: "allowed", reasons: [], policyVersion: "test" }
    },
    cache: { hit: false }
  };
}

describe("SqliteSnapshotStore", () => {
  let dataDir: string;
  let store: SnapshotStore;
  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousBackend = process.env.OCTORYN_SCOUT_STORAGE_BACKEND;
  const url = `https://example.com/page-${randomUUID()}`;

  beforeEach(async () => {
    // Hermetic SQLite-backed store under a fresh OS temp dir.
    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-sqlite-snap-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    process.env.OCTORYN_SCOUT_STORAGE_BACKEND = "sqlite";
    // Postgres takes precedence over everything; make sure it is not selected.
    delete process.env.DATABASE_URL;
    // Fresh connection cache so we open the temp-dir database, not a stale one.
    resetSqliteDbCache();
    store = createSnapshotStore();
    await store.init();

    // Deterministic, distinct createdAt timestamps so newest-first ordering
    // is unambiguous (two real saves could otherwise collide on the same ms).
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
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

  it("saves three versions of a url with distinct ids and hashes", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const first = await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    const second = await store.save(makeResult(url, "hash-bbb", "Second"));

    vi.setSystemTime(new Date("2026-06-30T00:02:00.000Z"));
    const third = await store.save(makeResult(url, "hash-ccc", "Third"));

    const ids = new Set([first.id, second.id, third.id]);
    expect(ids.size).toBe(3);

    const versions = await store.listVersionsByUrl(url);
    expect(versions).toHaveLength(3);
  });

  it("getById and getLatestByUrl round-trip the full result", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    const latest = await store.save(makeResult(url, "hash-bbb", "Second"));

    const byId = await store.getById(latest.id);
    expect(byId?.id).toBe(latest.id);
    expect(byId?.result.extraction.title).toBe("Second");
    expect(byId?.finalUrl).toBe(url);

    const got = await store.getLatestByUrl(url);
    expect(got?.id).toBe(latest.id);
    expect(got?.contentHash).toBe("hash-bbb");
  });

  it("findByHash returns matching snapshot, newest on repeat, undefined when none", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const first = await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    const second = await store.save(makeResult(url, "hash-bbb", "Second"));

    expect((await store.findByHash(url, "hash-aaa"))?.id).toBe(first.id);
    expect((await store.findByHash(url, "hash-bbb"))?.id).toBe(second.id);
    expect(await store.findByHash(url, "no-such-hash")).toBeUndefined();
    expect(await store.findByHash("https://other.example/x", "hash-aaa")).toBeUndefined();

    // A repeated hash returns the newest matching snapshot.
    vi.setSystemTime(new Date("2026-06-30T00:05:00.000Z"));
    const newer = await store.save(makeResult(url, "hash-aaa", "Newer"));
    expect((await store.findByHash(url, "hash-aaa"))?.id).toBe(newer.id);
  });

  it("listVersionsByUrl returns versions newest-first with title and status", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    await store.save(makeResult(url, "hash-bbb", "Second"));

    vi.setSystemTime(new Date("2026-06-30T00:02:00.000Z"));
    await store.save(makeResult(url, "hash-ccc", "Third"));

    const versions = await store.listVersionsByUrl(url);
    expect(versions.map((v) => v.contentHash)).toEqual(["hash-ccc", "hash-bbb", "hash-aaa"]);
    expect(versions.map((v) => v.title)).toEqual(["Third", "Second", "First"]);
    expect(versions.every((v) => v.governanceStatus === "allowed")).toBe(true);

    const createdAt = versions.map((v) => Date.parse(v.createdAt));
    expect(createdAt[0]).toBeGreaterThan(createdAt[1]);
    expect(createdAt[1]).toBeGreaterThan(createdAt[2]);

    // limit is honored.
    const limited = await store.listVersionsByUrl(url, 2);
    expect(limited.map((v) => v.contentHash)).toEqual(["hash-ccc", "hash-bbb"]);
  });

  it("getFreshByUrl honors ttlSeconds against createdAt", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));

    // 100s later: fresh within a 200s ttl, stale within a 50s ttl.
    vi.setSystemTime(new Date("2026-06-30T00:01:40.000Z"));
    expect(await store.getFreshByUrl(url, 200)).toBeDefined();
    expect(await store.getFreshByUrl(url, 50)).toBeUndefined();
  });

  it("returns empty/undefined for an unknown url", async () => {
    const unknown = "https://example.com/never-saved";
    expect(await store.listVersionsByUrl(unknown)).toEqual([]);
    expect(await store.getLatestByUrl(unknown)).toBeUndefined();
    expect(await store.findByHash(unknown, "hash-aaa")).toBeUndefined();
    expect(await store.getFreshByUrl(unknown, 1000)).toBeUndefined();
  });

  it("deleteById removes a single version and reports success", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const first = await store.save(makeResult(url, "hash-aaa", "First"));
    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    await store.save(makeResult(url, "hash-bbb", "Second"));

    expect(await store.deleteById(first.id)).toBe(true);
    expect(await store.getById(first.id)).toBeUndefined();
    expect(await store.listVersionsByUrl(url)).toHaveLength(1);
    expect(await store.deleteById(first.id)).toBe(false);
  });

  it("deleteByUrl removes every version for the url and leaves others intact", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));
    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    await store.save(makeResult(url, "hash-bbb", "Second"));
    vi.setSystemTime(new Date("2026-06-30T00:02:00.000Z"));
    await store.save(makeResult(url, "hash-ccc", "Third"));

    // A second, unrelated url that must survive the purge.
    const other = `https://example.com/other-${randomUUID()}`;
    const otherRec = await store.save(makeResult(other, "hash-zzz", "Other"));

    expect(await store.listVersionsByUrl(url)).toHaveLength(3);

    const removed = await store.deleteByUrl(url);
    expect(removed).toBe(3);

    expect(await store.listVersionsByUrl(url)).toEqual([]);
    expect(await store.getLatestByUrl(url)).toBeUndefined();
    expect(await store.listUrls()).not.toContain(url);

    // The unrelated url is untouched.
    expect(await store.getById(otherRec.id)).toBeDefined();
    expect(await store.listVersionsByUrl(other)).toHaveLength(1);
    expect(await store.listUrls()).toContain(other);
  });

  it("deleteByUrl returns 0 for an unknown url", async () => {
    expect(await store.deleteByUrl("https://example.com/never-saved")).toBe(0);
  });
});
