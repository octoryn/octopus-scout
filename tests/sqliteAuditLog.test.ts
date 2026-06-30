import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSqliteDbCache } from "../src/storage/sqlite.js";
import type { AuditLog } from "../src/governance/auditLog.js";

// Hermetic SQLite audit-log parity test. We point OCTORYN_SCOUT_DATA_DIR at a
// fresh temp directory, force the SQLite backend via OCTORYN_SCOUT_STORAGE_BACKEND,
// ensure DATABASE_URL is unset, reset the shared SQLite connection cache, and
// re-import the module each test so getAuditLog() rebuilds its module-level cache
// bound to our temp database.

let dataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let savedBackend: string | undefined;

async function freshAuditLog(): Promise<AuditLog> {
  vi.resetModules();
  resetSqliteDbCache();
  const mod = await import("../src/governance/auditLog.js");
  return mod.getAuditLog();
}

beforeEach(async () => {
  savedDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  savedBackend = process.env.OCTORYN_SCOUT_STORAGE_BACKEND;

  dataDir = await mkdtemp(join(tmpdir(), `octopus-sqlite-audit-${randomUUID()}-`));
  process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
  process.env.OCTORYN_SCOUT_STORAGE_BACKEND = "sqlite";
  delete process.env.DATABASE_URL;

  resetSqliteDbCache();
});

afterEach(async () => {
  resetSqliteDbCache();

  if (savedDataDir === undefined) delete process.env.OCTORYN_SCOUT_DATA_DIR;
  else process.env.OCTORYN_SCOUT_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  if (savedBackend === undefined) delete process.env.OCTORYN_SCOUT_STORAGE_BACKEND;
  else process.env.OCTORYN_SCOUT_STORAGE_BACKEND = savedBackend;

  await rm(dataDir, { recursive: true, force: true });
});

describe("SqliteAuditLog", () => {
  it("fills id and at on record and round-trips all fields", async () => {
    const log = await freshAuditLog();

    const created = await log.record({
      actor: "system",
      action: "crawl",
      target: "https://example.com",
      status: "ok",
      policyVersion: "v1",
      detail: { count: 3, nested: { ok: true } }
    });

    expect(created.id).toBeTruthy();
    expect(created.at).toBeTruthy();
    expect(() => new Date(created.at).toISOString()).not.toThrow();

    const [fetched] = await log.list({ target: "https://example.com" });
    expect(fetched).toEqual(created);
    expect(fetched.detail).toEqual({ count: 3, nested: { ok: true } });
  });

  it("honors caller-supplied id and at", async () => {
    const log = await freshAuditLog();
    const at = "2026-01-01T00:00:00.000Z";

    const created = await log.record({
      id: "fixed-id",
      at,
      actor: "u",
      action: "approve",
      target: "t",
      status: "done"
    });

    expect(created.id).toBe("fixed-id");
    expect(created.at).toBe(at);
    expect(created.policyVersion).toBeUndefined();
    expect(created.detail).toBeUndefined();
  });

  it("lists newest-first and filters by action and target with a limit", async () => {
    const log = await freshAuditLog();

    await log.record({ at: "2026-01-01T00:00:00.000Z", actor: "a", action: "crawl", target: "x", status: "ok" });
    await log.record({ at: "2026-01-02T00:00:00.000Z", actor: "a", action: "approve", target: "x", status: "ok" });
    await log.record({ at: "2026-01-03T00:00:00.000Z", actor: "a", action: "crawl", target: "x", status: "ok" });
    await log.record({ at: "2026-01-04T00:00:00.000Z", actor: "a", action: "crawl", target: "y", status: "ok" });

    const all = await log.list();
    expect(all.map((e) => e.at)).toEqual([
      "2026-01-04T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    ]);

    const crawlsOnX = await log.list({ action: "crawl", target: "x" });
    expect(crawlsOnX.map((e) => e.at)).toEqual(["2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);

    const limited = await log.list({ action: "crawl", limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].at).toBe("2026-01-04T00:00:00.000Z");
  });

  it("prunes by maxAge", async () => {
    const log = await freshAuditLog();
    const now = Date.now();

    await log.record({
      at: new Date(now - 10 * 60_000).toISOString(),
      actor: "a",
      action: "x",
      target: "t",
      status: "ok"
    });
    await log.record({
      at: new Date(now - 1 * 60_000).toISOString(),
      actor: "a",
      action: "x",
      target: "t",
      status: "ok"
    });

    const removed = await log.prune({ maxAgeMs: 5 * 60_000 });
    expect(removed).toBe(1);

    const remaining = await log.list();
    expect(remaining).toHaveLength(1);
    expect(Date.parse(remaining[0].at)).toBeGreaterThan(now - 5 * 60_000);
  });

  it("prunes by keepLast", async () => {
    const log = await freshAuditLog();

    await log.record({ at: "2026-01-01T00:00:00.000Z", actor: "a", action: "x", target: "t", status: "ok" });
    await log.record({ at: "2026-01-02T00:00:00.000Z", actor: "a", action: "x", target: "t", status: "ok" });
    await log.record({ at: "2026-01-03T00:00:00.000Z", actor: "a", action: "x", target: "t", status: "ok" });

    const removed = await log.prune({ keepLast: 2 });
    expect(removed).toBe(1);

    const remaining = await log.list();
    expect(remaining.map((e) => e.at)).toEqual(["2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]);
  });

  it("returns 0 when prune has no criteria and persists across reconnect", async () => {
    const log = await freshAuditLog();
    await log.record({ id: "persist-1", actor: "a", action: "x", target: "t", status: "ok" });
    expect(await log.prune({})).toBe(0);

    // Re-open against the same data dir; the row must still be there (durable).
    const reopened = await freshAuditLog();
    const rows = await reopened.list();
    expect(rows.map((e) => e.id)).toContain("persist-1");
  });
});
