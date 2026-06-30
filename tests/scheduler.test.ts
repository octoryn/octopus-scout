import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic staleness-sweep test for the schedule/scheduler module.
 *
 * Everything runs offline: a tiny node:http server on 127.0.0.1 serves one
 * HTML page (and an empty /robots.txt). The deterministic stub embedding
 * provider is forced (no provider keys), DATABASE_URL is cleared so the
 * file-backed snapshot + vector stores are used, and both are rooted in a
 * unique OS temp dir. Private/loopback hosts are allowed so the SSRF guard
 * does not block 127.0.0.1.
 *
 * Flow:
 *   1. ingestUrl() the fixture once so a snapshot exists on disk.
 *   2. runStalenessSweep({ maxAgeDays: ~0 }) so the just-created snapshot is
 *      counted as stale and re-ingested. Assert the result is well-formed:
 *      scanned >= 1, refreshed >= 1 (or a recorded failure with a reason if
 *      governance/network blocks the re-ingest), and items[] carry numeric
 *      ageSeconds.
 *   3. startScheduler() is a no-op returning a no-op stop fn when
 *      scheduleEnabled is false (the config default).
 *
 * Singletons read config lazily off process.env, so env is set BEFORE the
 * dynamic import and vi.resetModules() guarantees a fresh module graph.
 */

const MARKER = `quokka-${randomUUID().slice(0, 8)}`;

function fixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Staleness Fixture ${MARKER}</title>
    <meta name="description" content="A hermetic staleness-sweep test fixture" />
  </head>
  <body>
    <article>
      <h1>Staleness Fixture ${MARKER}</h1>
      <p>
        This fixture page about the ${MARKER} archipelago exists purely so the
        ingestion pipeline produces a single durable snapshot on disk. The prose
        is intentionally long enough for Readability to extract a meaningful
        article body and for the chunker to emit at least one chunk so the
        downstream vector index has something to store.
      </p>
      <p>
        Researchers studying the ${MARKER} archipelago documented a stable and
        distinctive corpus of prose that can be re-ingested deterministically in
        a hermetic test environment without any external network access.
      </p>
      <p>
        Additional paragraphs ensure ample body content so extraction and
        chunking behave exactly as they would for a real web article about the
        ${MARKER} archipelago and its unusual habitat.
      </p>
    </article>
  </body>
</html>`;
}

describe("scheduler: hermetic staleness sweep + disabled-schedule no-op", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;
  let dataDir: string;
  let canBind = true;

  const prev: Record<string, string | undefined> = {};
  function snapshotEnv(...keys: string[]): void {
    for (const k of keys) prev[k] = process.env[k];
  }
  function restoreEnv(): void {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(async () => {
    vi.resetModules();

    snapshotEnv(
      "OCTORYN_SCOUT_DATA_DIR",
      "DATABASE_URL",
      "OCTORYN_SCOUT_EMBEDDING_PROVIDER",
      "VOYAGE_API_KEY",
      "OPENAI_API_KEY",
      "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
      "OCTORYN_SCOUT_SCHEDULE_ENABLED"
    );

    // Force file-backed stores + deterministic stub embeddings; no DB/provider keys.
    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-scheduler-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    // Scheduling stays disabled (config default) so startScheduler() is a no-op.
    delete process.env.OCTORYN_SCOUT_SCHEDULE_ENABLED;

    const html = fixtureHtml();
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}/`;
    } catch {
      canBind = false;
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("refreshes a stale snapshot and reports a well-formed sweep result", { timeout: 30_000 }, async (ctx) => {
    if (!canBind) {
      // No localhost socket available in this sandbox; nothing to assert.
      ctx.skip();
      return;
    }

    // Import AFTER env is set so config-driven singletons (incl. the pipeline's
    // module-level snapshot store) pick up the temp dir + stub provider.
    const { ingestUrl } = await import("../src/knowledge/retrieval.js");
    const { runStalenessSweep, startScheduler, stopScheduler } = await import("../src/schedule/scheduler.js");

    // 1. Seed: ingest the fixture once so a snapshot exists on disk.
    const seeded = await ingestUrl({ url: baseUrl! });
    expect(seeded.skipped).toBeFalsy();
    expect(seeded.sourceUrl).toContain("127.0.0.1");
    expect(seeded.chunksIndexed).toBeGreaterThan(0);

    // 2. Sweep with a negative max age so even a zero-age (just-created)
    // snapshot is counted as stale and re-ingested (forceRefresh). The sweep
    // floors ageSeconds to whole seconds, so a tiny positive maxAge would round
    // to 0 and never trip; a negative threshold makes any age strictly stale.
    const result = await runStalenessSweep({ maxAgeDays: -0.0000001 });

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(typeof result.ranAt).toBe("string");
    expect(Number.isNaN(Date.parse(result.ranAt))).toBe(false);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThanOrEqual(1);

    // The seeded URL must appear among the stale items.
    const seededItem = result.items.find((i) => i.url.includes("127.0.0.1"));
    expect(seededItem).toBeDefined();

    // Every emitted item is well-formed.
    for (const item of result.items) {
      expect(typeof item.url).toBe("string");
      expect(typeof item.ageSeconds).toBe("number");
      expect(Number.isFinite(item.ageSeconds)).toBe(true);
      expect(item.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(typeof item.refreshed).toBe("boolean");
      if (!item.refreshed) {
        // A non-refreshed item must explain itself (governance block / error).
        expect(typeof item.reason).toBe("string");
        expect(item.reason && item.reason.length).toBeGreaterThan(0);
      }
    }

    // Accounting is internally consistent.
    expect(result.refreshed + result.failures).toBe(result.items.length);
    // The fixture is allowed (empty robots, public-ish stub governance), so the
    // re-ingest should succeed. If governance unexpectedly blocks it, that is
    // recorded as a failure with a reason instead.
    if (result.failures === 0) {
      expect(result.refreshed).toBeGreaterThanOrEqual(1);
      expect(seededItem!.refreshed).toBe(true);
    } else {
      expect(seededItem!.refreshed).toBe(false);
      expect(typeof seededItem!.reason).toBe("string");
    }

    // 3. startScheduler() is a no-op returning a no-op stop fn when disabled.
    const stop = startScheduler();
    expect(typeof stop).toBe("function");
    // Must not throw and must be safely callable / idempotent.
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();
    expect(() => stopScheduler()).not.toThrow();
  });
});
