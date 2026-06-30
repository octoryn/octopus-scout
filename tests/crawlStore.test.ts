import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlStore } from "../src/crawl/crawlStore.js";
import type { CrawlJobState, CrawlRequest } from "../src/types.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function makeOptions(url: string): CrawlRequest {
  return { url, maxDepth: 2, maxPages: 10 };
}

describe("FileCrawlStore via getCrawlStore", () => {
  let dataDir: string;
  let store: CrawlStore;
  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    // Hermetic file-backed store under a unique OS temp dir.
    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-crawl-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    // Force the file-backed store regardless of the ambient environment.
    delete process.env.DATABASE_URL;

    // getCrawlStore() reads config (and thus env) at call time, so reset the
    // module registry and re-import to be robust against any config memoization.
    vi.resetModules();
    const mod = await import("../src/crawl/crawlStore.js");
    store = mod.getCrawlStore();
    await store.init();
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

  it("create() returns a running job with a crawlId and ISO startedAt", async () => {
    const rootUrl = "https://example.com/";
    const job = await store.create(rootUrl, makeOptions(rootUrl));

    expect(job.crawlId).toEqual(expect.any(String));
    expect(job.crawlId.length).toBeGreaterThan(0);
    expect(job.rootUrl).toBe(rootUrl);
    expect(job.status).toBe("running");
    expect(job.startedAt).toMatch(ISO_RE);
    expect(job.updatedAt).toMatch(ISO_RE);
    expect(job.pages).toEqual([]);
    expect(job.frontier).toEqual([]);
    expect(job.finishedAt).toBeUndefined();
  });

  it("save() persists a mutated state that load() reads back", async () => {
    const rootUrl = "https://example.com/";
    const job = await store.create(rootUrl, makeOptions(rootUrl));

    // Seed a non-trivial frontier so we can observe it shrinking.
    job.frontier = [
      { url: "https://example.com/a", depth: 1 },
      { url: "https://example.com/b", depth: 1 }
    ];
    await store.save(job);

    // Mutate: crawl a page, shrink the frontier, mark completed, finish.
    job.pages.push({
      url: "https://example.com/a",
      depth: 1,
      status: 200,
      ok: true,
      title: "Page A"
    });
    job.visited.push("https://example.com/a");
    job.frontier = [{ url: "https://example.com/b", depth: 1 }];
    job.status = "completed";
    job.finishedAt = new Date("2026-06-30T00:00:00.000Z").toISOString();
    await store.save(job);

    const loaded = await store.load(job.crawlId);
    expect(loaded).toBeDefined();
    const state = loaded as CrawlJobState;

    expect(state.crawlId).toBe(job.crawlId);
    expect(state.status).toBe("completed");
    expect(state.finishedAt).toBe("2026-06-30T00:00:00.000Z");
    expect(state.pages).toHaveLength(1);
    expect(state.pages[0]).toMatchObject({ url: "https://example.com/a", title: "Page A" });
    expect(state.frontier).toEqual([{ url: "https://example.com/b", depth: 1 }]);
    expect(state.visited).toEqual(["https://example.com/a"]);
  });

  it("list() returns summaries with correct counts, newest-first", async () => {
    // Fake timers give each save a distinct updatedAt so ordering is unambiguous.
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const older = await store.create("https://older.example/", makeOptions("https://older.example/"));
    older.pages.push(
      { url: "https://older.example/1", depth: 1, status: 200, ok: true },
      { url: "https://older.example/2", depth: 1, status: 200, ok: true }
    );
    older.frontier = [{ url: "https://older.example/3", depth: 2 }];
    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    await store.save(older);

    vi.setSystemTime(new Date("2026-06-30T00:02:00.000Z"));
    const newer = await store.create("https://newer.example/", makeOptions("https://newer.example/"));
    newer.pages.push({ url: "https://newer.example/1", depth: 1, status: 200, ok: true });
    newer.frontier = [
      { url: "https://newer.example/2", depth: 1 },
      { url: "https://newer.example/3", depth: 1 },
      { url: "https://newer.example/4", depth: 1 }
    ];
    vi.setSystemTime(new Date("2026-06-30T00:03:00.000Z"));
    await store.save(newer);

    const summaries = await store.list();
    expect(summaries).toHaveLength(2);

    // newest-first: newer was saved last.
    expect(summaries[0].crawlId).toBe(newer.crawlId);
    expect(summaries[1].crawlId).toBe(older.crawlId);

    expect(summaries[0]).toMatchObject({
      rootUrl: "https://newer.example/",
      pagesCrawled: 1,
      frontierSize: 3
    });
    expect(summaries[1]).toMatchObject({
      rootUrl: "https://older.example/",
      pagesCrawled: 2,
      frontierSize: 1
    });

    expect(Date.parse(summaries[0].updatedAt)).toBeGreaterThan(Date.parse(summaries[1].updatedAt));
  });

  it("load() returns undefined for an unknown crawl id", async () => {
    expect(await store.load(`unknown-${randomUUID()}`)).toBeUndefined();
  });
});
