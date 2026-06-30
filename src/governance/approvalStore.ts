import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { getSqliteDb, resolveStorageBackend } from "../storage/sqlite.js";
import type { AppConfig } from "../config.js";
import type { ApprovalRecord, ApprovalStatus } from "../types.js";

export interface ApprovalStore {
  create(rec: { url: string; snapshotId?: string; contentHash: string; reasons: string[] }): Promise<ApprovalRecord>;
  list(status?: ApprovalStatus, limit?: number): Promise<ApprovalRecord[]>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  decide(
    id: string,
    decision: "approved" | "rejected",
    decidedBy: string,
    note?: string
  ): Promise<ApprovalRecord | undefined>;
  prune(opts: { maxAgeMs?: number; keepLast?: number; onlyDecided?: boolean }): Promise<number>;
}

/** Timestamp used for age comparisons: the decision time when present, else creation. */
function effectiveTime(rec: ApprovalRecord): number {
  return Date.parse(rec.decidedAt ?? rec.createdAt);
}

function newRecord(rec: { url: string; snapshotId?: string; contentHash: string; reasons: string[] }): ApprovalRecord {
  return {
    id: randomUUID(),
    url: rec.url,
    snapshotId: rec.snapshotId,
    contentHash: rec.contentHash,
    status: "pending",
    reasons: rec.reasons,
    createdAt: new Date().toISOString()
  };
}

function byNewest(a: ApprovalRecord, b: ApprovalRecord): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

let cached: ApprovalStore | undefined;

export function getApprovalStore(): ApprovalStore {
  if (cached) {
    return cached;
  }
  const config = loadConfig();
  if (config.databaseUrl) {
    cached = new PostgresApprovalStore(config.databaseUrl, config.dataDir);
    return cached;
  }
  cached =
    resolveStorageBackend(config) === "file" ? new FileApprovalStore(config.dataDir) : new SqliteApprovalStore(config);
  return cached;
}

class FileApprovalStore implements ApprovalStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "approvals.json");
  }

  async create(rec: {
    url: string;
    snapshotId?: string;
    contentHash: string;
    reasons: string[];
  }): Promise<ApprovalRecord> {
    const record = newRecord(rec);
    const all = await this.readAll();
    all[record.id] = record;
    await this.writeAll(all);
    return record;
  }

  async list(status?: ApprovalStatus, limit?: number): Promise<ApprovalRecord[]> {
    const all = await this.readAll();
    let records = Object.values(all);
    if (status !== undefined) {
      records = records.filter((r) => r.status === status);
    }
    records.sort(byNewest);
    return typeof limit === "number" && limit >= 0 ? records.slice(0, limit) : records;
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const all = await this.readAll();
    return all[id];
  }

  async decide(
    id: string,
    decision: "approved" | "rejected",
    decidedBy: string,
    note?: string
  ): Promise<ApprovalRecord | undefined> {
    const all = await this.readAll();
    const existing = all[id];
    if (!existing) {
      return undefined;
    }
    const updated: ApprovalRecord = {
      ...existing,
      status: decision,
      decidedAt: new Date().toISOString(),
      decidedBy,
      note
    };
    all[id] = updated;
    await this.writeAll(all);
    return updated;
  }

  async prune(opts: { maxAgeMs?: number; keepLast?: number; onlyDecided?: boolean }): Promise<number> {
    const all = await this.readAll();
    const records = Object.values(all);
    if (records.length === 0) {
      return 0;
    }

    const cutoff = typeof opts.maxAgeMs === "number" && opts.maxAgeMs >= 0 ? Date.now() - opts.maxAgeMs : undefined;
    const keepLast = typeof opts.keepLast === "number" && opts.keepLast >= 0 ? opts.keepLast : undefined;

    // Newest-first for keepLast accounting.
    const sorted = [...records].sort(byNewest);
    const removeIds = new Set<string>();
    sorted.forEach((rec, idx) => {
      if (opts.onlyDecided && rec.status === "pending") {
        return;
      }
      const protectedByKeepLast = keepLast !== undefined && idx < keepLast;
      const olderThanCutoff = cutoff !== undefined && effectiveTime(rec) < cutoff;
      // Remove when beyond keepLast and/or older than cutoff.
      const shouldRemove = (keepLast !== undefined && !protectedByKeepLast) || olderThanCutoff;
      if (shouldRemove && !protectedByKeepLast) {
        removeIds.add(rec.id);
      }
    });

    if (removeIds.size === 0) {
      return 0;
    }
    for (const id of removeIds) {
      delete all[id];
    }
    await this.writeAll(all);
    return removeIds.size;
  }

  private async readAll(): Promise<Record<string, ApprovalRecord>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as Record<string, ApprovalRecord>;
    } catch {
      return {};
    }
  }

  private async writeAll(all: Record<string, ApprovalRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(all, null, 2), "utf8");
  }
}

interface ApprovalRow {
  id: string;
  url: string;
  snapshot_id: string | null;
  content_hash: string;
  status: string;
  reasons_json: string;
  decided_by: string | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    url: row.url,
    snapshotId: row.snapshot_id == null ? undefined : row.snapshot_id,
    contentHash: row.content_hash,
    status: row.status as ApprovalStatus,
    reasons: JSON.parse(row.reasons_json) as string[],
    createdAt: row.created_at,
    decidedAt: row.decided_at == null ? undefined : row.decided_at,
    decidedBy: row.decided_by == null ? undefined : row.decided_by,
    note: row.note == null ? undefined : row.note
  };
}

/**
 * SQLite-backed approval store. Mirrors {@link FileApprovalStore} field-for-field
 * and semantics-for-semantics (including newest-first ordering and prune accounting),
 * so the approval workflow and applyApprovalDecision behave identically across backends.
 */
class SqliteApprovalStore implements ApprovalStore {
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    this.db = getSqliteDb(config);
    this.db.exec(
      `create table if not exists approvals (
        id text primary key,
        url text not null,
        snapshot_id text,
        content_hash text not null,
        status text not null,
        reasons_json text not null,
        decided_by text,
        note text,
        created_at text not null,
        decided_at text
      );
      create index if not exists approvals_status_created_idx
        on approvals (status, created_at desc);`
    );
  }

  async create(rec: {
    url: string;
    snapshotId?: string;
    contentHash: string;
    reasons: string[];
  }): Promise<ApprovalRecord> {
    const record = newRecord(rec);
    this.db
      .prepare(
        `insert into approvals
          (id, url, snapshot_id, content_hash, status, reasons_json, decided_by, note, created_at, decided_at)
         values (@id, @url, @snapshotId, @contentHash, @status, @reasonsJson, null, null, @createdAt, null)`
      )
      .run({
        id: record.id,
        url: record.url,
        snapshotId: record.snapshotId ?? null,
        contentHash: record.contentHash,
        status: record.status,
        reasonsJson: JSON.stringify(record.reasons),
        createdAt: record.createdAt
      });
    return record;
  }

  async list(status?: ApprovalStatus, limit?: number): Promise<ApprovalRecord[]> {
    const rows =
      status !== undefined
        ? (this.db
            .prepare(`select * from approvals where status = ? order by created_at desc`)
            .all(status) as ApprovalRow[])
        : (this.db.prepare(`select * from approvals order by created_at desc`).all() as ApprovalRow[]);
    const records = rows.map(rowToRecord);
    return typeof limit === "number" && limit >= 0 ? records.slice(0, limit) : records;
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const row = this.db.prepare(`select * from approvals where id = ?`).get(id) as ApprovalRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  async decide(
    id: string,
    decision: "approved" | "rejected",
    decidedBy: string,
    note?: string
  ): Promise<ApprovalRecord | undefined> {
    const existing = this.db.prepare(`select * from approvals where id = ?`).get(id) as ApprovalRow | undefined;
    if (!existing) {
      return undefined;
    }
    const decidedAt = new Date().toISOString();
    this.db
      .prepare(`update approvals set status = ?, decided_at = ?, decided_by = ?, note = ? where id = ?`)
      .run(decision, decidedAt, decidedBy, note ?? null, id);
    return {
      ...rowToRecord(existing),
      status: decision,
      decidedAt,
      decidedBy,
      note
    };
  }

  async prune(opts: { maxAgeMs?: number; keepLast?: number; onlyDecided?: boolean }): Promise<number> {
    const records = (this.db.prepare(`select * from approvals`).all() as ApprovalRow[]).map(rowToRecord);
    if (records.length === 0) {
      return 0;
    }

    const cutoff = typeof opts.maxAgeMs === "number" && opts.maxAgeMs >= 0 ? Date.now() - opts.maxAgeMs : undefined;
    const keepLast = typeof opts.keepLast === "number" && opts.keepLast >= 0 ? opts.keepLast : undefined;

    // Newest-first for keepLast accounting (mirrors FileApprovalStore exactly).
    const sorted = [...records].sort(byNewest);
    const removeIds = new Set<string>();
    sorted.forEach((rec, idx) => {
      if (opts.onlyDecided && rec.status === "pending") {
        return;
      }
      const protectedByKeepLast = keepLast !== undefined && idx < keepLast;
      const olderThanCutoff = cutoff !== undefined && effectiveTime(rec) < cutoff;
      const shouldRemove = (keepLast !== undefined && !protectedByKeepLast) || olderThanCutoff;
      if (shouldRemove && !protectedByKeepLast) {
        removeIds.add(rec.id);
      }
    });

    if (removeIds.size === 0) {
      return 0;
    }
    const del = this.db.prepare(`delete from approvals where id = ?`);
    const removeMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        del.run(id);
      }
    });
    removeMany([...removeIds]);
    return removeIds.size;
  }
}

class PostgresApprovalStore implements ApprovalStore {
  private readonly pool: pg.Pool;
  private readonly fallback: FileApprovalStore;
  private ready: Promise<boolean> | undefined;

  constructor(databaseUrl: string, dataDir: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
    this.fallback = new FileApprovalStore(dataDir);
  }

  private async ensureReady(): Promise<boolean> {
    if (!this.ready) {
      this.ready = this.pool
        .query(
          `create table if not exists approval_requests (
            id text primary key,
            url text not null,
            snapshot_id text,
            content_hash text not null,
            status text not null,
            reasons jsonb not null,
            created_at timestamptz not null,
            decided_at timestamptz,
            decided_by text,
            note text
          );
          create index if not exists approval_requests_status_created_idx
            on approval_requests (status, created_at desc);`
        )
        .then(() => true)
        .catch(() => false);
    }
    return this.ready;
  }

  async create(rec: {
    url: string;
    snapshotId?: string;
    contentHash: string;
    reasons: string[];
  }): Promise<ApprovalRecord> {
    const record = newRecord(rec);
    if (!(await this.ensureReady())) {
      return this.fallback.create(rec);
    }
    try {
      await this.pool.query(
        `insert into approval_requests
          (id, url, snapshot_id, content_hash, status, reasons, created_at, decided_at, decided_by, note)
         values ($1, $2, $3, $4, $5, $6, $7, null, null, null)`,
        [
          record.id,
          record.url,
          record.snapshotId ?? null,
          record.contentHash,
          record.status,
          JSON.stringify(record.reasons),
          record.createdAt
        ]
      );
      return record;
    } catch {
      return this.fallback.create(rec);
    }
  }

  async list(status?: ApprovalStatus, limit?: number): Promise<ApprovalRecord[]> {
    if (!(await this.ensureReady())) {
      return this.fallback.list(status, limit);
    }
    try {
      const params: unknown[] = [];
      let where = "";
      if (status !== undefined) {
        params.push(status);
        where = `where status = $${params.length}`;
      }
      const limitClause = typeof limit === "number" && limit >= 0 ? `limit ${Math.floor(limit)}` : "";
      const result = await this.pool.query(
        `select id, url, snapshot_id, content_hash, status, reasons, created_at, decided_at, decided_by, note
         from approval_requests
         ${where}
         order by created_at desc
         ${limitClause}`,
        params
      );
      return result.rows.map((row) => this.toRecord(row as Record<string, unknown>));
    } catch {
      return this.fallback.list(status, limit);
    }
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    if (!(await this.ensureReady())) {
      return this.fallback.get(id);
    }
    try {
      const result = await this.pool.query(
        `select id, url, snapshot_id, content_hash, status, reasons, created_at, decided_at, decided_by, note
         from approval_requests where id = $1`,
        [id]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? this.toRecord(row) : undefined;
    } catch {
      return this.fallback.get(id);
    }
  }

  async decide(
    id: string,
    decision: "approved" | "rejected",
    decidedBy: string,
    note?: string
  ): Promise<ApprovalRecord | undefined> {
    if (!(await this.ensureReady())) {
      return this.fallback.decide(id, decision, decidedBy, note);
    }
    try {
      const result = await this.pool.query(
        `update approval_requests
         set status = $2, decided_at = $3, decided_by = $4, note = $5
         where id = $1
         returning id, url, snapshot_id, content_hash, status, reasons, created_at, decided_at, decided_by, note`,
        [id, decision, new Date().toISOString(), decidedBy, note ?? null]
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? this.toRecord(row) : undefined;
    } catch {
      return this.fallback.decide(id, decision, decidedBy, note);
    }
  }

  async prune(opts: { maxAgeMs?: number; keepLast?: number; onlyDecided?: boolean }): Promise<number> {
    if (!(await this.ensureReady())) {
      return this.fallback.prune(opts);
    }
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (opts.onlyDecided) {
        conditions.push(`status <> 'pending'`);
      }
      if (typeof opts.maxAgeMs === "number" && opts.maxAgeMs >= 0) {
        params.push(new Date(Date.now() - opts.maxAgeMs).toISOString());
        // Age is measured against the decision time when present, else creation.
        conditions.push(`coalesce(decided_at, created_at) < $${params.length}`);
      }
      if (typeof opts.keepLast === "number" && opts.keepLast >= 0) {
        params.push(Math.floor(opts.keepLast));
        conditions.push(
          `id not in (select id from approval_requests order by coalesce(decided_at, created_at) desc limit $${params.length})`
        );
      }
      if (conditions.length === 0) {
        return 0;
      }
      const result = await this.pool.query(`delete from approval_requests where ${conditions.join(" and ")}`, params);
      return result.rowCount ?? 0;
    } catch {
      return this.fallback.prune(opts);
    }
  }

  private toRecord(row: Record<string, unknown>): ApprovalRecord {
    const rawReasons = row.reasons;
    const reasons = Array.isArray(rawReasons)
      ? (rawReasons as unknown[]).map((r) => String(r))
      : typeof rawReasons === "string"
        ? (JSON.parse(rawReasons) as string[])
        : [];
    return {
      id: String(row.id),
      url: String(row.url),
      snapshotId: row.snapshot_id == null ? undefined : String(row.snapshot_id),
      contentHash: String(row.content_hash),
      status: String(row.status) as ApprovalStatus,
      reasons,
      createdAt: new Date(String(row.created_at)).toISOString(),
      decidedAt: row.decided_at == null ? undefined : new Date(String(row.decided_at)).toISOString(),
      decidedBy: row.decided_by == null ? undefined : String(row.decided_by),
      note: row.note == null ? undefined : String(row.note)
    };
  }
}
