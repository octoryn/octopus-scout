import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import pg from "pg";
import { loadConfig, type AppConfig } from "../config.js";
import { getSqliteDb, resolveStorageBackend } from "./sqlite.js";
import type { GovernanceDecision, ScrapeResult, SnapshotRecord, SnapshotSummary } from "../types.js";

export interface SnapshotStore {
  init(): Promise<void>;
  save(result: ScrapeResult): Promise<SnapshotRecord>;
  getFreshByUrl(url: string, ttlSeconds: number): Promise<SnapshotRecord | undefined>;
  getById(id: string): Promise<SnapshotRecord | undefined>;
  findByHash(url: string, contentHash: string): Promise<SnapshotRecord | undefined>;
  listVersionsByUrl(url: string, limit?: number): Promise<SnapshotSummary[]>;
  getLatestByUrl(url: string): Promise<SnapshotRecord | undefined>;
  deleteById(id: string): Promise<boolean>;
  /** Delete every persisted snapshot version for a url; returns the count removed. */
  deleteByUrl(url: string): Promise<number>;
  listUrls(): Promise<string[]>;
}

export function createSnapshotStore(): SnapshotStore {
  const config = loadConfig();
  if (config.databaseUrl) {
    return new PostgresSnapshotStore(config.databaseUrl);
  }
  const backend = resolveStorageBackend(config);
  if (backend === "sqlite") {
    return new SqliteSnapshotStore(config);
  }
  return new FileSnapshotStore(config.dataDir);
}

/** Per-url history entry persisted in the file index. */
interface HistoryEntry {
  id: string;
  contentHash: string;
  createdAt: string;
  title?: string;
  governanceStatus?: GovernanceDecision["status"];
}

interface FileIndex {
  latestByUrl: Record<string, string>;
  historyByUrl: Record<string, HistoryEntry[]>;
}

const DEFAULT_VERSION_LIMIT = 50;

function titleOf(result: ScrapeResult): string | undefined {
  return result.extraction.title;
}

function governanceStatusOf(result: ScrapeResult): GovernanceDecision["status"] | undefined {
  return result.evidence.governance.status;
}

class FileSnapshotStore implements SnapshotStore {
  private readonly snapshotsDir: string;
  private readonly indexPath: string;

  constructor(private readonly dataDir: string) {
    this.snapshotsDir = join(dataDir, "snapshots");
    this.indexPath = join(dataDir, "index.json");
  }

  async init(): Promise<void> {
    await mkdir(this.snapshotsDir, { recursive: true });
    await mkdir(dirname(this.indexPath), { recursive: true });
  }

  async save(result: ScrapeResult): Promise<SnapshotRecord> {
    await this.init();
    const record: SnapshotRecord = {
      id: randomUUID(),
      url: result.request.url,
      finalUrl: result.fetch.finalUrl,
      contentHash: result.evidence.contentHash,
      createdAt: new Date().toISOString(),
      result
    };

    await writeFile(this.recordPath(record.id), JSON.stringify(record, null, 2));

    const index = await this.readIndex();
    index.latestByUrl[record.url] = record.id;
    const history = index.historyByUrl[record.url] ?? [];
    history.push({
      id: record.id,
      contentHash: record.contentHash,
      createdAt: record.createdAt,
      title: titleOf(result),
      governanceStatus: governanceStatusOf(result)
    });
    index.historyByUrl[record.url] = history;
    await writeFile(this.indexPath, JSON.stringify(index, null, 2));

    return record;
  }

  async getFreshByUrl(url: string, ttlSeconds: number): Promise<SnapshotRecord | undefined> {
    await this.init();
    const index = await this.readIndex();
    const id = index.latestByUrl[url];
    if (!id) {
      return undefined;
    }
    const record = await this.getById(id);
    if (!record) {
      return undefined;
    }
    const ageSeconds = (Date.now() - Date.parse(record.createdAt)) / 1000;
    return ageSeconds <= ttlSeconds ? record : undefined;
  }

  async getById(id: string): Promise<SnapshotRecord | undefined> {
    try {
      const raw = await readFile(this.recordPath(id), "utf8");
      return JSON.parse(raw) as SnapshotRecord;
    } catch {
      return undefined;
    }
  }

  async findByHash(url: string, contentHash: string): Promise<SnapshotRecord | undefined> {
    await this.init();
    const index = await this.readIndex();
    const history = index.historyByUrl[url] ?? [];
    // Newest-first so a dedup hit returns the most recent matching snapshot.
    const sorted = [...history].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const entry of sorted) {
      if (entry.contentHash === contentHash) {
        const record = await this.getById(entry.id);
        if (record) {
          return record;
        }
      }
    }
    return undefined;
  }

  async listVersionsByUrl(url: string, limit = DEFAULT_VERSION_LIMIT): Promise<SnapshotSummary[]> {
    await this.init();
    const index = await this.readIndex();
    const history = index.historyByUrl[url] ?? [];
    const sorted = [...history].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const limited = limit > 0 ? sorted.slice(0, limit) : sorted;
    const summaries: SnapshotSummary[] = [];
    for (const entry of limited) {
      const record = await this.getById(entry.id);
      summaries.push({
        id: entry.id,
        url,
        finalUrl: record?.finalUrl ?? url,
        contentHash: entry.contentHash,
        createdAt: entry.createdAt,
        title: entry.title,
        governanceStatus: entry.governanceStatus
      });
    }
    return summaries;
  }

  async getLatestByUrl(url: string): Promise<SnapshotRecord | undefined> {
    await this.init();
    const index = await this.readIndex();
    const history = index.historyByUrl[url];
    if (history && history.length > 0) {
      const newest = [...history].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      const record = await this.getById(newest.id);
      if (record) {
        return record;
      }
    }
    // Back-compat: fall back to the latestByUrl pointer if history is absent.
    const id = index.latestByUrl[url];
    if (!id) {
      return undefined;
    }
    return this.getById(id);
  }

  async deleteById(id: string): Promise<boolean> {
    await this.init();
    const index = await this.readIndex();
    let removed = false;

    // Remove the snapshot file, if present.
    try {
      await rm(this.recordPath(id), { force: false });
      removed = true;
    } catch {
      // File already gone; we may still need to clean up the index.
    }

    // Remove the id from any per-url history and latest pointer.
    let indexChanged = false;
    for (const [url, history] of Object.entries(index.historyByUrl)) {
      const next = history.filter((entry) => entry.id !== id);
      if (next.length !== history.length) {
        indexChanged = true;
        removed = true;
        if (next.length > 0) {
          index.historyByUrl[url] = next;
        } else {
          delete index.historyByUrl[url];
        }
      }
    }
    for (const [url, latestId] of Object.entries(index.latestByUrl)) {
      if (latestId !== id) {
        continue;
      }
      indexChanged = true;
      // Repoint latest to the newest survivor for this url, if any.
      const survivors = index.historyByUrl[url] ?? [];
      if (survivors.length > 0) {
        const newest = [...survivors].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        index.latestByUrl[url] = newest.id;
      } else {
        delete index.latestByUrl[url];
      }
    }

    if (indexChanged) {
      await writeFile(this.indexPath, JSON.stringify(index, null, 2));
    }

    return removed;
  }

  async deleteByUrl(url: string): Promise<number> {
    await this.init();
    const index = await this.readIndex();
    const history = index.historyByUrl[url] ?? [];
    // Collect every snapshot id known for this url (history + latest pointer).
    const ids = new Set<string>(history.map((entry) => entry.id));
    const latestId = index.latestByUrl[url];
    if (latestId) {
      ids.add(latestId);
    }

    let removed = 0;
    for (const id of ids) {
      try {
        await rm(this.recordPath(id), { force: false });
        removed += 1;
      } catch {
        // File already gone; still drop the index entry below.
      }
    }

    let indexChanged = false;
    if (url in index.historyByUrl) {
      delete index.historyByUrl[url];
      indexChanged = true;
    }
    if (url in index.latestByUrl) {
      delete index.latestByUrl[url];
      indexChanged = true;
    }
    if (indexChanged) {
      await writeFile(this.indexPath, JSON.stringify(index, null, 2));
    }

    return removed;
  }

  async listUrls(): Promise<string[]> {
    await this.init();
    const index = await this.readIndex();
    const urls = new Set<string>([...Object.keys(index.historyByUrl), ...Object.keys(index.latestByUrl)]);
    return [...urls];
  }

  private recordPath(id: string): string {
    return join(this.snapshotsDir, `${id}.json`);
  }

  private async readIndex(): Promise<FileIndex> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FileIndex>;
      // Tolerate an old index that only has latestByUrl and lacks historyByUrl.
      return {
        latestByUrl: parsed.latestByUrl ?? {},
        historyByUrl: parsed.historyByUrl ?? {}
      };
    } catch {
      return { latestByUrl: {}, historyByUrl: {} };
    }
  }
}

/** Row shape persisted in the SQLite `snapshots` table. */
interface SnapshotRow {
  id: string;
  url: string;
  final_url: string;
  content_hash: string;
  created_at: string;
  result_json: string;
}

class SqliteSnapshotStore implements SnapshotStore {
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    this.db = getSqliteDb(config);
    this.db.exec(`
      create table if not exists snapshots (
        id text primary key,
        url text not null,
        final_url text not null,
        content_hash text not null,
        created_at text not null,
        result_json text not null
      );
      create index if not exists snapshots_url_created_idx
        on snapshots (url, created_at desc);
      create index if not exists snapshots_url_hash_idx
        on snapshots (url, content_hash);
    `);
  }

  async init(): Promise<void> {
    // Tables are created in the constructor; nothing to do here.
  }

  async save(result: ScrapeResult): Promise<SnapshotRecord> {
    const record: SnapshotRecord = {
      id: randomUUID(),
      url: result.request.url,
      finalUrl: result.fetch.finalUrl,
      contentHash: result.evidence.contentHash,
      createdAt: new Date().toISOString(),
      result
    };

    this.db
      .prepare(
        `insert into snapshots (id, url, final_url, content_hash, created_at, result_json)
         values (@id, @url, @finalUrl, @contentHash, @createdAt, @resultJson)`
      )
      .run({
        id: record.id,
        url: record.url,
        finalUrl: record.finalUrl,
        contentHash: record.contentHash,
        createdAt: record.createdAt,
        resultJson: JSON.stringify(record.result)
      });

    return record;
  }

  async getFreshByUrl(url: string, ttlSeconds: number): Promise<SnapshotRecord | undefined> {
    const row = this.db
      .prepare(
        `select id, url, final_url, content_hash, created_at, result_json
         from snapshots
         where url = ?
         order by created_at desc
         limit 1`
      )
      .get(url) as SnapshotRow | undefined;
    if (!row) {
      return undefined;
    }
    const ageSeconds = (Date.now() - Date.parse(row.created_at)) / 1000;
    return ageSeconds <= ttlSeconds ? this.toRecord(row) : undefined;
  }

  async getById(id: string): Promise<SnapshotRecord | undefined> {
    const row = this.db
      .prepare(
        `select id, url, final_url, content_hash, created_at, result_json
         from snapshots where id = ?`
      )
      .get(id) as SnapshotRow | undefined;
    return this.toRecord(row);
  }

  async findByHash(url: string, contentHash: string): Promise<SnapshotRecord | undefined> {
    // Newest-first so a dedup hit returns the most recent matching snapshot.
    const row = this.db
      .prepare(
        `select id, url, final_url, content_hash, created_at, result_json
         from snapshots
         where url = ? and content_hash = ?
         order by created_at desc
         limit 1`
      )
      .get(url, contentHash) as SnapshotRow | undefined;
    return this.toRecord(row);
  }

  async listVersionsByUrl(url: string, limit = DEFAULT_VERSION_LIMIT): Promise<SnapshotSummary[]> {
    const effectiveLimit = limit > 0 ? limit : -1;
    const rows = this.db
      .prepare(
        `select id, url, final_url, content_hash, created_at, result_json
         from snapshots
         where url = ?
         order by created_at desc
         limit ?`
      )
      .all(url, effectiveLimit) as SnapshotRow[];
    return rows.map((row) => this.toSummary(row));
  }

  async getLatestByUrl(url: string): Promise<SnapshotRecord | undefined> {
    const row = this.db
      .prepare(
        `select id, url, final_url, content_hash, created_at, result_json
         from snapshots
         where url = ?
         order by created_at desc
         limit 1`
      )
      .get(url) as SnapshotRow | undefined;
    return this.toRecord(row);
  }

  async deleteById(id: string): Promise<boolean> {
    const info = this.db.prepare(`delete from snapshots where id = ?`).run(id);
    return info.changes > 0;
  }

  async deleteByUrl(url: string): Promise<number> {
    const info = this.db.prepare(`delete from snapshots where url = ?`).run(url);
    return info.changes;
  }

  async listUrls(): Promise<string[]> {
    const rows = this.db.prepare(`select distinct url from snapshots`).all() as Array<{ url: string }>;
    return rows.map((row) => row.url);
  }

  private toSummary(row: SnapshotRow): SnapshotSummary {
    const result = JSON.parse(row.result_json) as ScrapeResult;
    return {
      id: row.id,
      url: row.url,
      finalUrl: row.final_url,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      title: titleOf(result),
      governanceStatus: governanceStatusOf(result)
    };
  }

  private toRecord(row: SnapshotRow | undefined): SnapshotRecord | undefined {
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      url: row.url,
      finalUrl: row.final_url,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      result: JSON.parse(row.result_json) as ScrapeResult
    };
  }
}

class PostgresSnapshotStore implements SnapshotStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      create table if not exists ingestion_snapshots (
        id text primary key,
        url text not null,
        final_url text not null,
        content_hash text not null,
        created_at timestamptz not null,
        result jsonb not null
      );
      create index if not exists ingestion_snapshots_url_created_idx
        on ingestion_snapshots (url, created_at desc);
      create index if not exists ingestion_snapshots_hash_idx
        on ingestion_snapshots (content_hash);
    `);
  }

  async save(result: ScrapeResult): Promise<SnapshotRecord> {
    await this.init();
    const record: SnapshotRecord = {
      id: randomUUID(),
      url: result.request.url,
      finalUrl: result.fetch.finalUrl,
      contentHash: result.evidence.contentHash,
      createdAt: new Date().toISOString(),
      result
    };

    await this.pool.query(
      `insert into ingestion_snapshots
        (id, url, final_url, content_hash, created_at, result)
       values ($1, $2, $3, $4, $5, $6)`,
      [record.id, record.url, record.finalUrl, record.contentHash, record.createdAt, record.result]
    );

    return record;
  }

  async getFreshByUrl(url: string, ttlSeconds: number): Promise<SnapshotRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `select id, url, final_url, content_hash, created_at, result
       from ingestion_snapshots
       where url = $1 and created_at >= now() - ($2 || ' seconds')::interval
       order by created_at desc
       limit 1`,
      [url, ttlSeconds]
    );
    return this.toRecord(result.rows[0]);
  }

  async getById(id: string): Promise<SnapshotRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `select id, url, final_url, content_hash, created_at, result
       from ingestion_snapshots where id = $1`,
      [id]
    );
    return this.toRecord(result.rows[0]);
  }

  async findByHash(url: string, contentHash: string): Promise<SnapshotRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `select id, url, final_url, content_hash, created_at, result
       from ingestion_snapshots
       where url = $1 and content_hash = $2
       order by created_at desc
       limit 1`,
      [url, contentHash]
    );
    return this.toRecord(result.rows[0]);
  }

  async getLatestByUrl(url: string): Promise<SnapshotRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `select id, url, final_url, content_hash, created_at, result
       from ingestion_snapshots
       where url = $1
       order by created_at desc
       limit 1`,
      [url]
    );
    return this.toRecord(result.rows[0]);
  }

  async listVersionsByUrl(url: string, limit = DEFAULT_VERSION_LIMIT): Promise<SnapshotSummary[]> {
    await this.init();
    const result = await this.pool.query(
      `select id, url, final_url, content_hash, created_at,
              result->'extraction'->>'title' as title,
              result->'evidence'->'governance'->>'status' as governance_status
       from ingestion_snapshots
       where url = $1
       order by created_at desc
       limit $2`,
      [url, limit]
    );
    return result.rows.map((row) => this.toSummary(row as Record<string, unknown>));
  }

  async deleteById(id: string): Promise<boolean> {
    await this.init();
    const result = await this.pool.query(`delete from ingestion_snapshots where id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteByUrl(url: string): Promise<number> {
    await this.init();
    const result = await this.pool.query(`delete from ingestion_snapshots where url = $1`, [url]);
    return result.rowCount ?? 0;
  }

  async listUrls(): Promise<string[]> {
    await this.init();
    const result = await this.pool.query(`select distinct url from ingestion_snapshots`);
    return result.rows.map((row) => String((row as Record<string, unknown>).url));
  }

  private toSummary(row: Record<string, unknown>): SnapshotSummary {
    const status = row.governance_status;
    return {
      id: String(row.id),
      url: String(row.url),
      finalUrl: String(row.final_url),
      contentHash: String(row.content_hash),
      createdAt: new Date(String(row.created_at)).toISOString(),
      title: row.title == null ? undefined : String(row.title),
      governanceStatus: status == null ? undefined : (String(status) as GovernanceDecision["status"])
    };
  }

  private toRecord(row: Record<string, unknown> | undefined): SnapshotRecord | undefined {
    if (!row) {
      return undefined;
    }

    return {
      id: String(row.id),
      url: String(row.url),
      finalUrl: String(row.final_url),
      contentHash: String(row.content_hash),
      createdAt: new Date(String(row.created_at)).toISOString(),
      result: row.result as ScrapeResult
    };
  }
}
