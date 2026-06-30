import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import type { AppConfig } from "../config.js";
import { getSqliteDb, resolveStorageBackend } from "../storage/sqlite.js";
import type { CrawlJobState, CrawlJobSummary, CrawlRequest } from "../types.js";

/**
 * Persistence for long-running crawl jobs so they can be checkpointed,
 * listed, and resumed. A Postgres backend is used when a database URL is
 * configured; otherwise jobs are stored as JSON files under the data dir.
 * Neither backend throws at import time, and both degrade gracefully when
 * the underlying store is unavailable.
 */
export interface CrawlStore {
  init(): Promise<void>;
  create(rootUrl: string, options: CrawlRequest): Promise<CrawlJobState>;
  save(state: CrawlJobState): Promise<void>;
  load(crawlId: string): Promise<CrawlJobState | undefined>;
  list(limit?: number): Promise<CrawlJobSummary[]>;
}

const DEFAULT_LIST_LIMIT = 50;

export function getCrawlStore(): CrawlStore {
  const config = loadConfig();
  if (config.databaseUrl) {
    return new PostgresCrawlStore(config.databaseUrl);
  }
  if (resolveStorageBackend(config) === "sqlite") {
    return new SqliteCrawlStore(config);
  }
  return new FileCrawlStore(config.dataDir);
}

function newJobState(rootUrl: string, options: CrawlRequest): CrawlJobState {
  const now = new Date().toISOString();
  return {
    crawlId: randomUUID(),
    rootUrl,
    options,
    status: "running",
    frontier: [],
    visited: [],
    pages: [],
    startedAt: now,
    updatedAt: now
  };
}

function summarize(state: CrawlJobState): CrawlJobSummary {
  return {
    crawlId: state.crawlId,
    rootUrl: state.rootUrl,
    status: state.status,
    pagesCrawled: state.pages.length,
    frontierSize: state.frontier.length,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    finishedAt: state.finishedAt
  };
}

class FileCrawlStore implements CrawlStore {
  private readonly crawlsDir: string;

  constructor(dataDir: string) {
    this.crawlsDir = join(dataDir, "crawls");
  }

  async init(): Promise<void> {
    await mkdir(this.crawlsDir, { recursive: true });
  }

  async create(rootUrl: string, options: CrawlRequest): Promise<CrawlJobState> {
    const state = newJobState(rootUrl, options);
    await this.save(state);
    return state;
  }

  async save(state: CrawlJobState): Promise<void> {
    await this.init();
    state.updatedAt = new Date().toISOString();
    await writeFile(this.jobPath(state.crawlId), JSON.stringify(state, null, 2));
  }

  async load(crawlId: string): Promise<CrawlJobState | undefined> {
    try {
      const raw = await readFile(this.jobPath(crawlId), "utf8");
      return JSON.parse(raw) as CrawlJobState;
    } catch {
      return undefined;
    }
  }

  async list(limit = DEFAULT_LIST_LIMIT): Promise<CrawlJobSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.crawlsDir);
    } catch {
      return [];
    }
    const summaries: CrawlJobSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const raw = await readFile(join(this.crawlsDir, entry), "utf8");
        const state = JSON.parse(raw) as CrawlJobState;
        summaries.push(summarize(state));
      } catch {
        // Tolerate corrupt/partial files.
      }
    }
    summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return limit > 0 ? summaries.slice(0, limit) : summaries;
  }

  private jobPath(crawlId: string): string {
    return join(this.crawlsDir, `${crawlId}.json`);
  }
}

class SqliteCrawlStore implements CrawlStore {
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    this.db = getSqliteDb(config);
    this.db.exec(`
      create table if not exists crawl_jobs (
        crawl_id text primary key,
        root_url text not null,
        status text not null,
        started_at text not null,
        updated_at text not null,
        finished_at text,
        state text not null
      );
      create index if not exists crawl_jobs_updated_idx
        on crawl_jobs (updated_at desc);
    `);
  }

  async init(): Promise<void> {
    // Tables are created in the constructor; nothing to do.
  }

  async create(rootUrl: string, options: CrawlRequest): Promise<CrawlJobState> {
    const state = newJobState(rootUrl, options);
    await this.save(state);
    return state;
  }

  async save(state: CrawlJobState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `insert into crawl_jobs
          (crawl_id, root_url, status, started_at, updated_at, finished_at, state)
         values (@crawlId, @rootUrl, @status, @startedAt, @updatedAt, @finishedAt, @state)
         on conflict (crawl_id) do update set
           root_url = excluded.root_url,
           status = excluded.status,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at,
           finished_at = excluded.finished_at,
           state = excluded.state`
      )
      .run({
        crawlId: state.crawlId,
        rootUrl: state.rootUrl,
        status: state.status,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        finishedAt: state.finishedAt ?? null,
        state: JSON.stringify(state)
      });
  }

  async load(crawlId: string): Promise<CrawlJobState | undefined> {
    const row = this.db.prepare(`select state from crawl_jobs where crawl_id = ?`).get(crawlId) as
      { state: string } | undefined;
    if (!row) {
      return undefined;
    }
    return JSON.parse(row.state) as CrawlJobState;
  }

  async list(limit = DEFAULT_LIST_LIMIT): Promise<CrawlJobSummary[]> {
    const rows = this.db.prepare(`select state from crawl_jobs order by updated_at desc`).all() as {
      state: string;
    }[];
    const summaries = rows.map((row) => summarize(JSON.parse(row.state) as CrawlJobState));
    return limit > 0 ? summaries.slice(0, limit) : summaries;
  }
}

class PostgresCrawlStore implements CrawlStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      create table if not exists crawl_jobs (
        crawl_id text primary key,
        root_url text not null,
        status text not null,
        started_at timestamptz not null,
        updated_at timestamptz not null,
        finished_at timestamptz,
        state jsonb not null
      );
      create index if not exists crawl_jobs_updated_idx
        on crawl_jobs (updated_at desc);
    `);
  }

  async create(rootUrl: string, options: CrawlRequest): Promise<CrawlJobState> {
    const state = newJobState(rootUrl, options);
    await this.save(state);
    return state;
  }

  async save(state: CrawlJobState): Promise<void> {
    await this.init();
    state.updatedAt = new Date().toISOString();
    await this.pool.query(
      `insert into crawl_jobs
        (crawl_id, root_url, status, started_at, updated_at, finished_at, state)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (crawl_id) do update set
         root_url = excluded.root_url,
         status = excluded.status,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at,
         finished_at = excluded.finished_at,
         state = excluded.state`,
      [state.crawlId, state.rootUrl, state.status, state.startedAt, state.updatedAt, state.finishedAt ?? null, state]
    );
  }

  async load(crawlId: string): Promise<CrawlJobState | undefined> {
    await this.init();
    const result = await this.pool.query(`select state from crawl_jobs where crawl_id = $1`, [crawlId]);
    const row = result.rows[0] as { state: CrawlJobState } | undefined;
    return row ? (row.state as CrawlJobState) : undefined;
  }

  async list(limit = DEFAULT_LIST_LIMIT): Promise<CrawlJobSummary[]> {
    await this.init();
    const result = await this.pool.query(
      `select crawl_id, root_url, status, started_at, updated_at, finished_at,
              jsonb_array_length(coalesce(state->'pages', '[]'::jsonb)) as pages_crawled,
              jsonb_array_length(coalesce(state->'frontier', '[]'::jsonb)) as frontier_size
       from crawl_jobs
       order by updated_at desc
       limit $1`,
      [limit]
    );
    return result.rows.map((row) => this.toSummary(row as Record<string, unknown>));
  }

  private toSummary(row: Record<string, unknown>): CrawlJobSummary {
    const finishedAt = row.finished_at;
    return {
      crawlId: String(row.crawl_id),
      rootUrl: String(row.root_url),
      status: String(row.status) as CrawlJobSummary["status"],
      pagesCrawled: Number(row.pages_crawled ?? 0),
      frontierSize: Number(row.frontier_size ?? 0),
      startedAt: new Date(String(row.started_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
      finishedAt: finishedAt == null ? undefined : new Date(String(finishedAt)).toISOString()
    };
  }
}
