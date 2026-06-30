import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import pg from "pg";
import { loadConfig, type AppConfig } from "../config.js";
import { getSqliteDb, resolveStorageBackend } from "../storage/sqlite.js";
import { sha256 } from "../utils/hash.js";
import type { GovernanceDecision, StoredExtraction } from "../types.js";

/**
 * Persistence for LLM structured extractions (cf. Firecrawl /extract results).
 *
 * Mirrors {@link createSnapshotStore} EXACTLY in shape: a File / SQLite /
 * Postgres backend selected by {@link resolveStorageBackend}, the SQLite table
 * created in the constructor via `CREATE TABLE IF NOT EXISTS`, and a pg pool
 * for Postgres.
 *
 * GOVERNANCE CONTRACT (mirrors the vector store): reads — {@link
 * ExtractionStore.list} and {@link ExtractionStore.listByUrl} — exclude any
 * extraction whose `governanceStatus !== "allowed"` BY DEFAULT. Setting
 * `opts.includeUnapproved` re-includes `requires_approval` rows, but `blocked`
 * extractions are never returned (and should never be persisted in the first
 * place — that is the caller's responsibility, same as snapshots).
 */
export interface ExtractionStore {
  init(): Promise<void>;
  save(rec: StoredExtraction): Promise<StoredExtraction>;
  getById(id: string): Promise<StoredExtraction | undefined>;
  listByUrl(url: string, limit?: number): Promise<StoredExtraction[]>;
  list(limit?: number, opts?: { includeUnapproved?: boolean }): Promise<StoredExtraction[]>;
  /** Delete every persisted extraction for a url; returns the count removed. */
  deleteByUrl(url: string): Promise<number>;
}

export function createExtractionStore(): ExtractionStore {
  const config = loadConfig();
  if (config.databaseUrl) {
    return new PostgresExtractionStore(config.databaseUrl);
  }
  const backend = resolveStorageBackend(config);
  if (backend === "sqlite") {
    return new SqliteExtractionStore(config);
  }
  return new FileExtractionStore(config.dataDir);
}

/**
 * Compute the schema hash: sha256 of the canonical JSON of the schema. Keys are
 * sorted recursively so two structurally identical schemas (differing only in
 * key order) hash to the same value.
 */
export function schemaHash(schema: Record<string, unknown>): string {
  return sha256(canonicalJson(schema));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

const DEFAULT_LIST_LIMIT = 100;

/** A read is allowed through the governance gate unless it is blocked / not approved. */
function isReadable(status: GovernanceDecision["status"], includeUnapproved: boolean): boolean {
  if (status === "blocked") {
    return false;
  }
  if (status === "requires_approval") {
    return includeUnapproved;
  }
  return true;
}

interface FileIndex {
  byUrl: Record<string, string[]>;
}

class FileExtractionStore implements ExtractionStore {
  private readonly extractionsDir: string;
  private readonly indexPath: string;

  constructor(private readonly dataDir: string) {
    this.extractionsDir = join(dataDir, "extractions");
    this.indexPath = join(dataDir, "extractions-index.json");
  }

  async init(): Promise<void> {
    await mkdir(this.extractionsDir, { recursive: true });
    await mkdir(dirname(this.indexPath), { recursive: true });
  }

  async save(rec: StoredExtraction): Promise<StoredExtraction> {
    await this.init();
    await writeFile(this.recordPath(rec.id), JSON.stringify(rec, null, 2));

    const index = await this.readIndex();
    const ids = index.byUrl[rec.sourceUrl] ?? [];
    ids.push(rec.id);
    index.byUrl[rec.sourceUrl] = ids;
    await writeFile(this.indexPath, JSON.stringify(index, null, 2));

    return rec;
  }

  async getById(id: string): Promise<StoredExtraction | undefined> {
    try {
      const raw = await readFile(this.recordPath(id), "utf8");
      return JSON.parse(raw) as StoredExtraction;
    } catch {
      return undefined;
    }
  }

  async listByUrl(url: string, limit = DEFAULT_LIST_LIMIT): Promise<StoredExtraction[]> {
    await this.init();
    const index = await this.readIndex();
    const ids = index.byUrl[url] ?? [];
    const records: StoredExtraction[] = [];
    for (const id of ids) {
      const record = await this.getById(id);
      if (record && isReadable(record.governanceStatus, false)) {
        records.push(record);
      }
    }
    return this.sortAndLimit(records, limit);
  }

  async list(limit = DEFAULT_LIST_LIMIT, opts?: { includeUnapproved?: boolean }): Promise<StoredExtraction[]> {
    await this.init();
    const index = await this.readIndex();
    const includeUnapproved = opts?.includeUnapproved ?? false;
    const records: StoredExtraction[] = [];
    for (const ids of Object.values(index.byUrl)) {
      for (const id of ids) {
        const record = await this.getById(id);
        if (record && isReadable(record.governanceStatus, includeUnapproved)) {
          records.push(record);
        }
      }
    }
    return this.sortAndLimit(records, limit);
  }

  async deleteByUrl(url: string): Promise<number> {
    await this.init();
    const index = await this.readIndex();
    const ids = index.byUrl[url] ?? [];

    let removed = 0;
    for (const id of ids) {
      try {
        await rm(this.recordPath(id), { force: false });
        removed += 1;
      } catch {
        // File already gone; still drop the index entry below.
      }
    }

    if (url in index.byUrl) {
      delete index.byUrl[url];
      await writeFile(this.indexPath, JSON.stringify(index, null, 2));
    }

    return removed;
  }

  private sortAndLimit(records: StoredExtraction[], limit: number): StoredExtraction[] {
    const sorted = records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  private recordPath(id: string): string {
    return join(this.extractionsDir, `${id}.json`);
  }

  private async readIndex(): Promise<FileIndex> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileIndex>;
      return { byUrl: parsed.byUrl ?? {} };
    } catch {
      return { byUrl: {} };
    }
  }
}

/** Row shape persisted in the SQLite `extractions` table. */
interface ExtractionRow {
  id: string;
  source_url: string;
  schema_hash: string;
  content_hash: string | null;
  governance_status: string;
  created_at: string;
  result_json: string;
}

class SqliteExtractionStore implements ExtractionStore {
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    this.db = getSqliteDb(config);
    this.db.exec(`
      create table if not exists extractions (
        id text primary key,
        source_url text not null,
        schema_hash text not null,
        content_hash text,
        governance_status text not null,
        created_at text not null,
        result_json text not null
      );
      create index if not exists extractions_url_created_idx
        on extractions (source_url, created_at desc);
      create index if not exists extractions_status_idx
        on extractions (governance_status);
    `);
  }

  async init(): Promise<void> {
    // Table is created in the constructor; nothing to do here.
  }

  async save(rec: StoredExtraction): Promise<StoredExtraction> {
    this.db
      .prepare(
        `insert into extractions
          (id, source_url, schema_hash, content_hash, governance_status, created_at, result_json)
         values (@id, @sourceUrl, @schemaHash, @contentHash, @governanceStatus, @createdAt, @resultJson)`
      )
      .run({
        id: rec.id,
        sourceUrl: rec.sourceUrl,
        schemaHash: rec.schemaHash,
        contentHash: rec.contentHash ?? null,
        governanceStatus: rec.governanceStatus,
        createdAt: rec.createdAt,
        resultJson: JSON.stringify(rec)
      });

    return rec;
  }

  async getById(id: string): Promise<StoredExtraction | undefined> {
    const row = this.db.prepare(`select result_json from extractions where id = ?`).get(id) as
      Pick<ExtractionRow, "result_json"> | undefined;
    return row ? (JSON.parse(row.result_json) as StoredExtraction) : undefined;
  }

  async listByUrl(url: string, limit = DEFAULT_LIST_LIMIT): Promise<StoredExtraction[]> {
    const effectiveLimit = limit > 0 ? limit : -1;
    const rows = this.db
      .prepare(
        `select result_json from extractions
         where source_url = ? and governance_status = 'allowed'
         order by created_at desc
         limit ?`
      )
      .all(url, effectiveLimit) as Array<Pick<ExtractionRow, "result_json">>;
    return rows.map((row) => JSON.parse(row.result_json) as StoredExtraction);
  }

  async list(limit = DEFAULT_LIST_LIMIT, opts?: { includeUnapproved?: boolean }): Promise<StoredExtraction[]> {
    const includeUnapproved = opts?.includeUnapproved ?? false;
    const effectiveLimit = limit > 0 ? limit : -1;
    // Never return "blocked"; include "requires_approval" only when opted in.
    const statusClause = includeUnapproved
      ? `governance_status in ('allowed', 'requires_approval')`
      : `governance_status = 'allowed'`;
    const rows = this.db
      .prepare(
        `select result_json from extractions
         where ${statusClause}
         order by created_at desc
         limit ?`
      )
      .all(effectiveLimit) as Array<Pick<ExtractionRow, "result_json">>;
    return rows.map((row) => JSON.parse(row.result_json) as StoredExtraction);
  }

  async deleteByUrl(url: string): Promise<number> {
    const info = this.db.prepare(`delete from extractions where source_url = ?`).run(url);
    return info.changes;
  }
}

class PostgresExtractionStore implements ExtractionStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      create table if not exists structured_extractions (
        id text primary key,
        source_url text not null,
        schema_hash text not null,
        content_hash text,
        governance_status text not null,
        created_at timestamptz not null,
        result jsonb not null
      );
      create index if not exists structured_extractions_url_created_idx
        on structured_extractions (source_url, created_at desc);
      create index if not exists structured_extractions_status_idx
        on structured_extractions (governance_status);
    `);
  }

  async save(rec: StoredExtraction): Promise<StoredExtraction> {
    await this.init();
    await this.pool.query(
      `insert into structured_extractions
        (id, source_url, schema_hash, content_hash, governance_status, created_at, result)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [rec.id, rec.sourceUrl, rec.schemaHash, rec.contentHash ?? null, rec.governanceStatus, rec.createdAt, rec]
    );
    return rec;
  }

  async getById(id: string): Promise<StoredExtraction | undefined> {
    await this.init();
    const result = await this.pool.query(`select result from structured_extractions where id = $1`, [id]);
    return this.toRecord(result.rows[0]);
  }

  async listByUrl(url: string, limit = DEFAULT_LIST_LIMIT): Promise<StoredExtraction[]> {
    await this.init();
    const result = await this.pool.query(
      `select result from structured_extractions
       where source_url = $1 and governance_status = 'allowed'
       order by created_at desc
       limit $2`,
      [url, limit]
    );
    return result.rows.map((row) => this.toRecord(row as Record<string, unknown>)!);
  }

  async list(limit = DEFAULT_LIST_LIMIT, opts?: { includeUnapproved?: boolean }): Promise<StoredExtraction[]> {
    await this.init();
    const includeUnapproved = opts?.includeUnapproved ?? false;
    const statusClause = includeUnapproved
      ? `governance_status in ('allowed', 'requires_approval')`
      : `governance_status = 'allowed'`;
    const result = await this.pool.query(
      `select result from structured_extractions
       where ${statusClause}
       order by created_at desc
       limit $1`,
      [limit]
    );
    return result.rows.map((row) => this.toRecord(row as Record<string, unknown>)!);
  }

  async deleteByUrl(url: string): Promise<number> {
    await this.init();
    const result = await this.pool.query(`delete from structured_extractions where source_url = $1`, [url]);
    return result.rowCount ?? 0;
  }

  private toRecord(row: Record<string, unknown> | undefined): StoredExtraction | undefined {
    if (!row) {
      return undefined;
    }
    return row.result as StoredExtraction;
  }
}
