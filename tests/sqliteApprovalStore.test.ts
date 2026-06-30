import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSqliteDbCache } from "../src/storage/sqlite.js";
import type { ApprovalStore } from "../src/governance/approvalStore.js";

// Hermetic SQLite-backed approval store parity test. We point
// OCTORYN_SCOUT_DATA_DIR at a fresh temp directory, force the SQLite backend via
// OCTORYN_SCOUT_STORAGE_BACKEND, ensure DATABASE_URL is unset, reset the shared
// SQLite connection cache, and re-import the module each test so
// getApprovalStore() rebuilds its module-level cache bound to our temp database.

let dataDir: string;
let savedDataDir: string | undefined;
let savedBackend: string | undefined;
let savedDatabaseUrl: string | undefined;

async function freshStore(): Promise<ApprovalStore> {
  vi.resetModules();
  resetSqliteDbCache();
  const mod = await import("../src/governance/approvalStore.js");
  return mod.getApprovalStore();
}

beforeEach(async () => {
  savedDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  savedBackend = process.env.OCTORYN_SCOUT_STORAGE_BACKEND;
  savedDatabaseUrl = process.env.DATABASE_URL;

  dataDir = await mkdtemp(join(tmpdir(), `octopus-sqlite-approval-${randomUUID()}-`));
  process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
  process.env.OCTORYN_SCOUT_STORAGE_BACKEND = "sqlite";
  delete process.env.DATABASE_URL;

  resetSqliteDbCache();
});

afterEach(async () => {
  resetSqliteDbCache();

  if (savedDataDir === undefined) delete process.env.OCTORYN_SCOUT_DATA_DIR;
  else process.env.OCTORYN_SCOUT_DATA_DIR = savedDataDir;

  if (savedBackend === undefined) delete process.env.OCTORYN_SCOUT_STORAGE_BACKEND;
  else process.env.OCTORYN_SCOUT_STORAGE_BACKEND = savedBackend;

  if (savedDatabaseUrl !== undefined) process.env.DATABASE_URL = savedDatabaseUrl;

  await rm(dataDir, { recursive: true, force: true });
});

describe("SqliteApprovalStore parity", () => {
  it("create yields a pending record with all persisted fields", async () => {
    const store = await freshStore();
    const rec = await store.create({
      url: "https://example.com/a",
      snapshotId: "snap-1",
      contentHash: "hash-a",
      reasons: ["new", "policy"]
    });

    expect(rec.status).toBe("pending");
    expect(rec.url).toBe("https://example.com/a");
    expect(rec.snapshotId).toBe("snap-1");
    expect(rec.contentHash).toBe("hash-a");
    expect(rec.reasons).toEqual(["new", "policy"]);
    expect(typeof rec.id).toBe("string");
    expect(typeof rec.createdAt).toBe("string");
    expect(rec.decidedAt).toBeUndefined();
    expect(rec.decidedBy).toBeUndefined();
    expect(rec.note).toBeUndefined();

    const round = await store.get(rec.id);
    expect(round).toEqual(rec);
  });

  it("list filters by status and returns newest-first", async () => {
    const store = await freshStore();
    const a = await store.create({ url: "https://x/1", contentHash: "h1", reasons: [] });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ url: "https://x/2", contentHash: "h2", reasons: [] });

    const pending = await store.list("pending");
    expect(pending.map((r) => r.id)).toEqual([b.id, a.id]);

    await store.decide(a.id, "approved", "alice");
    expect((await store.list("pending")).map((r) => r.id)).toEqual([b.id]);
    expect((await store.list("approved")).map((r) => r.id)).toEqual([a.id]);

    const limited = await store.list(undefined, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.id).toBe(b.id);
  });

  it("decide sets status, decidedBy, decidedAt and note; returns updated record", async () => {
    const store = await freshStore();
    const rec = await store.create({ url: "https://x/d", contentHash: "h", reasons: ["r"] });

    const approved = await store.decide(rec.id, "approved", "alice", "looks good");
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedBy).toBe("alice");
    expect(approved?.note).toBe("looks good");
    expect(typeof approved?.decidedAt).toBe("string");
    expect(approved?.id).toBe(rec.id);
    expect(approved?.url).toBe(rec.url);
    expect(approved?.contentHash).toBe(rec.contentHash);

    const persisted = await store.get(rec.id);
    expect(persisted).toEqual(approved);

    const rejected = await store.create({ url: "https://x/r", contentHash: "h2", reasons: [] });
    const decided = await store.decide(rejected.id, "rejected", "bob");
    expect(decided?.status).toBe("rejected");
    expect(decided?.decidedBy).toBe("bob");
    expect(decided?.note).toBeUndefined();
  });

  it("decide returns undefined for a missing id", async () => {
    const store = await freshStore();
    expect(await store.decide("does-not-exist", "approved", "alice")).toBeUndefined();
  });

  it("prune onlyDecided keeps pending records and removes decided ones", async () => {
    const store = await freshStore();
    const pending = await store.create({ url: "https://x/p", contentHash: "h", reasons: [] });
    const decided = await store.create({ url: "https://x/q", contentHash: "h2", reasons: [] });
    await store.decide(decided.id, "approved", "alice");

    const removed = await store.prune({ onlyDecided: true, keepLast: 0 });
    expect(removed).toBe(1);
    expect(await store.get(decided.id)).toBeUndefined();
    expect(await store.get(pending.id)).toBeDefined();
  });
});
