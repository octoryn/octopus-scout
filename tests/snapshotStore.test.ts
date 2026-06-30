import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotStore, type SnapshotStore } from "../src/storage/snapshotStore.js";
import type { ScrapeResult } from "../src/types.js";

/**
 * Build a minimal but type-complete ScrapeResult for a given url + contentHash.
 * Only the fields the FileSnapshotStore reads (url, finalUrl, contentHash,
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

describe("FileSnapshotStore", () => {
  let dataDir: string;
  let store: SnapshotStore;
  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const url = `https://example.com/page-${randomUUID()}`;

  beforeEach(async () => {
    // Hermetic file-backed store under a unique OS temp dir.
    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-snap-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    // Force the file-backed store regardless of the ambient environment.
    delete process.env.DATABASE_URL;
    store = createSnapshotStore();
    await store.init();

    // Deterministic, distinct createdAt timestamps so newest-first ordering
    // is unambiguous (two real saves could otherwise collide on the same ms).
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
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

  it("saves two snapshots for the same url with different content hashes", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const first = await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    const second = await store.save(makeResult(url, "hash-bbb", "Second"));

    expect(first.id).not.toBe(second.id);
    expect(first.contentHash).toBe("hash-aaa");
    expect(second.contentHash).toBe("hash-bbb");

    const versions = await store.listVersionsByUrl(url);
    expect(versions).toHaveLength(2);
  });

  it("findByHash returns the matching snapshot, undefined when none match", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const first = await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    const second = await store.save(makeResult(url, "hash-bbb", "Second"));

    const matchA = await store.findByHash(url, "hash-aaa");
    expect(matchA?.id).toBe(first.id);

    const matchB = await store.findByHash(url, "hash-bbb");
    expect(matchB?.id).toBe(second.id);

    expect(await store.findByHash(url, "no-such-hash")).toBeUndefined();
    expect(await store.findByHash("https://other.example/x", "hash-aaa")).toBeUndefined();
  });

  it("findByHash returns the newest matching snapshot when a hash repeats", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "same-hash", "Older"));

    vi.setSystemTime(new Date("2026-06-30T00:05:00.000Z"));
    const newer = await store.save(makeResult(url, "same-hash", "Newer"));

    const found = await store.findByHash(url, "same-hash");
    expect(found?.id).toBe(newer.id);
  });

  it("listVersionsByUrl returns versions newest-first", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    await store.save(makeResult(url, "hash-bbb", "Second"));

    vi.setSystemTime(new Date("2026-06-30T00:02:00.000Z"));
    await store.save(makeResult(url, "hash-ccc", "Third"));

    const versions = await store.listVersionsByUrl(url);
    expect(versions.map((v) => v.contentHash)).toEqual(["hash-ccc", "hash-bbb", "hash-aaa"]);
    expect(versions.map((v) => v.title)).toEqual(["Third", "Second", "First"]);

    const createdAt = versions.map((v) => Date.parse(v.createdAt));
    expect(createdAt[0]).toBeGreaterThan(createdAt[1]);
    expect(createdAt[1]).toBeGreaterThan(createdAt[2]);
  });

  it("getLatestByUrl returns the newest snapshot", async () => {
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    const latest = await store.save(makeResult(url, "hash-bbb", "Second"));

    const got = await store.getLatestByUrl(url);
    expect(got?.id).toBe(latest.id);
    expect(got?.contentHash).toBe("hash-bbb");
  });

  it("returns empty/undefined for an unknown url", async () => {
    const unknown = "https://example.com/never-saved";
    expect(await store.listVersionsByUrl(unknown)).toEqual([]);
    expect(await store.getLatestByUrl(unknown)).toBeUndefined();
    expect(await store.findByHash(unknown, "hash-aaa")).toBeUndefined();
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

    // Every version for the url is gone; latest pointer no longer resolves.
    expect(await store.listVersionsByUrl(url)).toEqual([]);
    expect(await store.getLatestByUrl(url)).toBeUndefined();
    expect(await store.listUrls()).not.toContain(url);

    // The unrelated url is untouched.
    expect(await store.getById(otherRec.id)).toBeDefined();
    expect(await store.listVersionsByUrl(other)).toHaveLength(1);
  });

  it("deleteByUrl returns 0 for an unknown url", async () => {
    expect(await store.deleteByUrl("https://example.com/never-saved")).toBe(0);
  });
});
