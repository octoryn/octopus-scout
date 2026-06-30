import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { getSqliteDb, resolveStorageBackend } from "../storage/sqlite.js";
import type { AuditEvent } from "../types.js";

export interface AuditLog {
  record(event: Omit<AuditEvent, "id" | "at"> & { id?: string; at?: string }): Promise<AuditEvent>;
  list(filter?: { target?: string; action?: string; limit?: number }): Promise<AuditEvent[]>;
  prune(opts: { maxAgeMs?: number; keepLast?: number }): Promise<number>;
}

type AuditInput = Omit<AuditEvent, "id" | "at"> & { id?: string; at?: string };

function materialize(event: AuditInput): AuditEvent {
  return {
    id: event.id ?? randomUUID(),
    at: event.at ?? new Date().toISOString(),
    actor: event.actor,
    action: event.action,
    target: event.target,
    status: event.status,
    policyVersion: event.policyVersion,
    detail: event.detail
  };
}

function matchesFilter(event: AuditEvent, filter?: { target?: string; action?: string }): boolean {
  if (filter?.target !== undefined && event.target !== filter.target) {
    return false;
  }
  if (filter?.action !== undefined && event.action !== filter.action) {
    return false;
  }
  return true;
}

let cached: AuditLog | undefined;

export function getAuditLog(): AuditLog {
  if (cached) {
    return cached;
  }
  const config = loadConfig();
  if (config.databaseUrl) {
    cached = new PostgresAuditLog(config.databaseUrl, config.dataDir);
    return cached;
  }
  cached = resolveStorageBackend(config) === "file" ? new FileAuditLog(config.dataDir) : new SqliteAuditLog(config);
  return cached;
}

class FileAuditLog implements AuditLog {
  private readonly logPath: string;

  constructor(dataDir: string) {
    this.logPath = join(dataDir, "audit.log");
  }

  async record(event: AuditInput): Promise<AuditEvent> {
    const full = materialize(event);
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }

  async list(filter?: { target?: string; action?: string; limit?: number }): Promise<AuditEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.logPath, "utf8");
    } catch {
      return [];
    }

    const events: AuditEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as AuditEvent;
        if (matchesFilter(parsed, filter)) {
          events.push(parsed);
        }
      } catch {
        // Skip malformed lines rather than failing the whole read.
      }
    }

    // Newest first.
    events.reverse();
    const limit = filter?.limit;
    return typeof limit === "number" && limit >= 0 ? events.slice(0, limit) : events;
  }

  async prune(opts: { maxAgeMs?: number; keepLast?: number }): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.logPath, "utf8");
    } catch {
      return 0;
    }

    const events: AuditEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as AuditEvent);
      } catch {
        // Skip malformed lines.
      }
    }

    const total = events.length;
    if (total === 0) {
      return 0;
    }

    // Newest first for keepLast accounting.
    const sorted = [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const cutoff = typeof opts.maxAgeMs === "number" && opts.maxAgeMs >= 0 ? Date.now() - opts.maxAgeMs : undefined;
    const keepLast = typeof opts.keepLast === "number" && opts.keepLast >= 0 ? opts.keepLast : undefined;

    const survivors = sorted.filter((event, idx) => {
      if (keepLast !== undefined && idx >= keepLast) {
        return false;
      }
      if (cutoff !== undefined && Date.parse(event.at) < cutoff) {
        return false;
      }
      return true;
    });

    const removed = total - survivors.length;
    if (removed === 0) {
      return 0;
    }

    // Rewrite the jsonl preserving original (oldest-first) order.
    survivors.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const body = survivors.map((event) => JSON.stringify(event)).join("\n");
    await mkdir(dirname(this.logPath), { recursive: true });
    await writeFile(this.logPath, body.length > 0 ? `${body}\n` : "", "utf8");
    return removed;
  }
}

interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  status: string;
  policy_version: string | null;
  detail_json: string | null;
}

class SqliteAuditLog implements AuditLog {
  private readonly db: Database.Database;

  constructor(config: Parameters<typeof getSqliteDb>[0]) {
    this.db = getSqliteDb(config);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_version TEXT,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_events_at_idx ON audit_events (at DESC);
      CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target);
      CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action);`
    );
  }

  async record(event: AuditInput): Promise<AuditEvent> {
    const full = materialize(event);
    this.db
      .prepare(
        `INSERT INTO audit_events (id, at, actor, action, target, status, policy_version, detail_json)
         VALUES (@id, @at, @actor, @action, @target, @status, @policyVersion, @detailJson)
         ON CONFLICT(id) DO NOTHING`
      )
      .run({
        id: full.id,
        at: full.at,
        actor: full.actor,
        action: full.action,
        target: full.target,
        status: full.status,
        policyVersion: full.policyVersion ?? null,
        detailJson: full.detail === undefined ? null : JSON.stringify(full.detail)
      });
    return full;
  }

  async list(filter?: { target?: string; action?: string; limit?: number }): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.target !== undefined) {
      conditions.push("target = @target");
      params.target = filter.target;
    }
    if (filter?.action !== undefined) {
      conditions.push("action = @action");
      params.action = filter.action;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit;
    let limitClause = "";
    if (typeof limit === "number" && limit >= 0) {
      limitClause = "LIMIT @limit";
      params.limit = Math.floor(limit);
    }

    const rows = this.db
      .prepare(
        `SELECT id, at, actor, action, target, status, policy_version, detail_json
         FROM audit_events
         ${where}
         ORDER BY at DESC, rowid DESC
         ${limitClause}`
      )
      .all(params) as AuditRow[];
    return rows.map((row) => this.toEvent(row));
  }

  async prune(opts: { maxAgeMs?: number; keepLast?: number }): Promise<number> {
    const cutoff =
      typeof opts.maxAgeMs === "number" && opts.maxAgeMs >= 0
        ? new Date(Date.now() - opts.maxAgeMs).toISOString()
        : undefined;
    const keepLast = typeof opts.keepLast === "number" && opts.keepLast >= 0 ? Math.floor(opts.keepLast) : undefined;
    if (cutoff === undefined && keepLast === undefined) {
      return 0;
    }

    const removed = this.db.transaction(() => {
      const conditions: string[] = [];
      const params: Record<string, unknown> = {};
      if (cutoff !== undefined) {
        conditions.push("at < @cutoff");
        params.cutoff = cutoff;
      }
      if (keepLast !== undefined) {
        conditions.push("id NOT IN (SELECT id FROM audit_events ORDER BY at DESC, rowid DESC LIMIT @keepLast)");
        params.keepLast = keepLast;
      }
      const result = this.db.prepare(`DELETE FROM audit_events WHERE ${conditions.join(" AND ")}`).run(params);
      return result.changes;
    })();
    return removed;
  }

  private toEvent(row: AuditRow): AuditEvent {
    return {
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
      target: row.target,
      status: row.status,
      policyVersion: row.policy_version == null ? undefined : row.policy_version,
      detail: row.detail_json == null ? undefined : (JSON.parse(row.detail_json) as Record<string, unknown>)
    };
  }
}

class PostgresAuditLog implements AuditLog {
  private readonly pool: pg.Pool;
  private readonly fallback: FileAuditLog;
  private ready: Promise<boolean> | undefined;

  constructor(databaseUrl: string, dataDir: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
    this.fallback = new FileAuditLog(dataDir);
  }

  private async ensureReady(): Promise<boolean> {
    if (!this.ready) {
      this.ready = this.pool
        .query(
          `create table if not exists audit_events (
            id text primary key,
            at timestamptz not null,
            actor text not null,
            action text not null,
            target text not null,
            status text not null,
            policy_version text,
            detail jsonb
          );
          create index if not exists audit_events_at_idx on audit_events (at desc);
          create index if not exists audit_events_target_idx on audit_events (target);
          create index if not exists audit_events_action_idx on audit_events (action);`
        )
        .then(() => true)
        .catch(() => false);
    }
    return this.ready;
  }

  async record(event: AuditInput): Promise<AuditEvent> {
    const full = materialize(event);
    if (!(await this.ensureReady())) {
      return this.fallback.record(full);
    }
    try {
      await this.pool.query(
        `insert into audit_events (id, at, actor, action, target, status, policy_version, detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do nothing`,
        [
          full.id,
          full.at,
          full.actor,
          full.action,
          full.target,
          full.status,
          full.policyVersion ?? null,
          full.detail ?? null
        ]
      );
      return full;
    } catch {
      return this.fallback.record(full);
    }
  }

  async list(filter?: { target?: string; action?: string; limit?: number }): Promise<AuditEvent[]> {
    if (!(await this.ensureReady())) {
      return this.fallback.list(filter);
    }
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filter?.target !== undefined) {
        params.push(filter.target);
        conditions.push(`target = $${params.length}`);
      }
      if (filter?.action !== undefined) {
        params.push(filter.action);
        conditions.push(`action = $${params.length}`);
      }
      const where = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
      const limit = filter?.limit;
      const limitClause = typeof limit === "number" && limit >= 0 ? `limit ${Math.floor(limit)}` : "";

      const result = await this.pool.query(
        `select id, at, actor, action, target, status, policy_version, detail
         from audit_events
         ${where}
         order by at desc
         ${limitClause}`,
        params
      );
      return result.rows.map((row) => this.toEvent(row as Record<string, unknown>));
    } catch {
      return this.fallback.list(filter);
    }
  }

  async prune(opts: { maxAgeMs?: number; keepLast?: number }): Promise<number> {
    if (!(await this.ensureReady())) {
      return this.fallback.prune(opts);
    }
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (typeof opts.maxAgeMs === "number" && opts.maxAgeMs >= 0) {
        params.push(new Date(Date.now() - opts.maxAgeMs).toISOString());
        conditions.push(`at < $${params.length}`);
      }
      if (typeof opts.keepLast === "number" && opts.keepLast >= 0) {
        params.push(Math.floor(opts.keepLast));
        conditions.push(`id not in (select id from audit_events order by at desc limit $${params.length})`);
      }
      if (conditions.length === 0) {
        return 0;
      }
      const result = await this.pool.query(`delete from audit_events where ${conditions.join(" and ")}`, params);
      return result.rowCount ?? 0;
    } catch {
      return this.fallback.prune(opts);
    }
  }

  private toEvent(row: Record<string, unknown>): AuditEvent {
    return {
      id: String(row.id),
      at: new Date(String(row.at)).toISOString(),
      actor: String(row.actor),
      action: String(row.action),
      target: String(row.target),
      status: String(row.status),
      policyVersion: row.policy_version == null ? undefined : String(row.policy_version),
      detail: (row.detail as Record<string, unknown> | null) ?? undefined
    };
  }
}
