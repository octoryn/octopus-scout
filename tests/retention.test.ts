import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapeResult } from "../src/types.js";

/**
 * Minimal but type-complete ScrapeResult. The FileSnapshotStore only reads
 * url, finalUrl, contentHash, extraction.title and evidence.governance.status,
 * so those are the only fields that need to be meaningful.
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

describe("runRetention (file-backed)", () => {
  let dataDir: string;
  const previousDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(async () => {
    // Hermetic: unique OS temp dir, file-backed stores (no DATABASE_URL).
    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-retention-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    // getAuditLog()/runRetention cache config-derived singletons at module
    // scope; reset so a fresh import binds to this temp dir.
    vi.resetModules();
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

  it("keeps only the newest snapshot version and removes the rest", async () => {
    const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
    const { runRetention } = await import("../src/storage/retention.js");

    const url = `https://example.com/page-${randomUUID()}`;
    const store = createSnapshotStore();
    await store.init();

    // Distinct, increasing createdAt so newest-first ordering is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));

    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    await store.save(makeResult(url, "hash-bbb", "Second"));

    vi.setSystemTime(new Date("2026-06-30T00:02:00.000Z"));
    const newest = await store.save(makeResult(url, "hash-ccc", "Third"));

    expect(await store.listVersionsByUrl(url)).toHaveLength(3);

    const report = await runRetention({ snapshotRetentionVersions: 1 });

    expect(report.snapshotsRemoved).toBe(2);

    const remaining = await store.listVersionsByUrl(url);
    expect(remaining).toHaveLength(1);
    // The single survivor is the newest version.
    expect(remaining[0].id).toBe(newest.id);
    expect(remaining[0].contentHash).toBe("hash-ccc");
  });

  it("does NOT purge vectors while a snapshot version for the url survives", async () => {
    const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
    const { getVectorStore } = await import("../src/knowledge/vectorStore.js");
    const { runRetention } = await import("../src/storage/retention.js");

    const url = `https://example.com/keep-${randomUUID()}`;
    const store = createSnapshotStore();
    await store.init();

    const vectors = getVectorStore();
    await vectors.init();
    await vectors.upsertChunks([
      {
        chunkId: randomUUID(),
        documentId: "doc-keep",
        sourceUrl: url,
        finalUrl: url,
        title: "Doc",
        contentHash: "hash-keep",
        index: 0,
        content: "indexed body",
        headingPath: [],
        governanceStatus: "allowed",
        trustScore: 0.9,
        capturedAt: "2026-06-30T00:00:00.000Z",
        embedding: [1, 0, 0]
      }
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    await store.save(makeResult(url, "hash-aaa", "First"));
    vi.setSystemTime(new Date("2026-06-30T00:01:00.000Z"));
    await store.save(makeResult(url, "hash-bbb", "Second"));

    // Keep only the newest version: one version is removed, one survives.
    const report = await runRetention({ snapshotRetentionVersions: 1 });
    expect(report.snapshotsRemoved).toBe(1);

    // A version still exists for the url, so its vectors must NOT be purged.
    const hits = await vectors.search([1, 0, 0], 10, { url });
    expect(hits.length).toBe(1);
  });

  it("purges orphaned vectors when no snapshot version remains for a url", async () => {
    const { getVectorStore } = await import("../src/knowledge/vectorStore.js");
    const { runRetention } = await import("../src/storage/retention.js");
    const snapMod = await import("../src/storage/snapshotStore.js");

    const url = `https://example.com/orphan-${randomUUID()}`;

    const vectors = getVectorStore();
    await vectors.init();
    await vectors.upsertChunks([
      {
        chunkId: randomUUID(),
        documentId: "doc-orphan",
        sourceUrl: url,
        finalUrl: url,
        title: "Doc",
        contentHash: "hash-orphan",
        index: 0,
        content: "indexed body",
        headingPath: [],
        governanceStatus: "allowed",
        trustScore: 0.9,
        capturedAt: "2026-06-30T00:00:00.000Z",
        embedding: [1, 0, 0]
      }
    ]);
    expect((await vectors.search([1, 0, 0], 10, { url })).length).toBe(1);

    // Stub the snapshot store so retention sees the url with two expirable
    // versions but ZERO remaining after deletion — exercising the orphan-vector
    // purge path deterministically.
    let deleted = 0;
    vi.spyOn(snapMod, "createSnapshotStore").mockReturnValue({
      init: async () => {},
      listUrls: async () => [url],
      // First call (expiry selection) sees both versions; after any deletion the
      // remaining-check reports zero, exercising the orphan-vector purge path.
      listVersionsByUrl: async () =>
        deleted >= 1
          ? []
          : ([
              { id: "v2", url, finalUrl: url, contentHash: "h2", createdAt: "2026-06-30T00:01:00.000Z" },
              { id: "v1", url, finalUrl: url, contentHash: "h1", createdAt: "2026-06-30T00:00:00.000Z" }
            ] as never),
      deleteById: async () => {
        deleted += 1;
        return true;
      }
    } as never);

    // keepVersions=1 removes the single non-newest version; the stub then reports
    // zero remaining for the url, so its orphaned vectors get purged.
    await runRetention({ snapshotRetentionVersions: 1, auditRetentionDays: 0 });

    expect((await vectors.search([1, 0, 0], 10, { url })).length).toBe(0);
  });

  it("prunes audit events and reports a non-negative removed count", async () => {
    const { getAuditLog } = await import("../src/governance/auditLog.js");
    const { runRetention } = await import("../src/storage/retention.js");

    const audit = getAuditLog();

    vi.useFakeTimers();
    // Record three events well in the past so an age-based horizon prunes them.
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await audit.record({ actor: "tester", action: "scrape", target: "a", status: "ok" });
    await audit.record({ actor: "tester", action: "scrape", target: "b", status: "ok" });
    await audit.record({ actor: "tester", action: "scrape", target: "c", status: "ok" });

    expect(await audit.list()).toHaveLength(3);

    // Now is far past the recorded events; a 1-day horizon expires all three.
    vi.setSystemTime(new Date("2026-06-30T00:00:00.000Z"));
    const report = await runRetention({ auditRetentionDays: 1 });

    expect(typeof report.auditEventsRemoved).toBe("number");
    expect(report.auditEventsRemoved).toBeGreaterThanOrEqual(0);
    expect(report.auditEventsRemoved).toBe(3);
    expect(await audit.list()).toHaveLength(0);
  });

  it("keeps audit events newer than the retention horizon (store keepLast)", async () => {
    const { getAuditLog } = await import("../src/governance/auditLog.js");

    const audit = getAuditLog();
    await audit.record({ actor: "tester", action: "scrape", target: "a", status: "ok" });
    await audit.record({ actor: "tester", action: "scrape", target: "b", status: "ok" });
    await audit.record({ actor: "tester", action: "scrape", target: "c", status: "ok" });

    // Deterministic prune via the store directly: keep the newest one.
    const removed = await audit.prune({ keepLast: 1 });
    expect(removed).toBe(2);
    expect(await audit.list()).toHaveLength(1);
  });
});
