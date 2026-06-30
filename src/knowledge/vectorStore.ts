import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import pg from "pg";
import { loadConfig, type AppConfig } from "../config.js";
import { getSqliteDb, resolveStorageBackend } from "../storage/sqlite.js";
import type { GovernanceDecision, StoredChunk, VectorSearchFilter, VectorSearchHit } from "../types.js";

/**
 * Vector store: the persistence + retrieval layer for embedded RAG chunks.
 *
 * Two interchangeable backends are provided:
 *  - {@link PostgresVectorStore} when `config.databaseUrl` is set.
 *  - {@link FileVectorStore} otherwise, rooted at `config.dataDir`.
 *
 * Both backends degrade gracefully: a missing/corrupt file store is treated as
 * empty, and a misconfigured/unreachable Postgres surfaces as a rejected
 * promise from the relevant method (never at import time). `getVectorStore`
 * itself never throws.
 */
export interface VectorStore {
  init(): Promise<void>;
  upsertChunks(chunks: StoredChunk[]): Promise<void>;
  deleteByUrl(sourceUrl: string): Promise<void>;
  /**
   * Re-stamp the governance status of every stored chunk for a given source
   * URL. Used by the approval workflow to release (`allowed`) or quarantine
   * chunks after a human decision. Returns the number of chunks updated.
   */
  setGovernanceStatusByUrl(sourceUrl: string, status: GovernanceDecision["status"]): Promise<number>;
  search(embedding: number[], topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]>;
  /**
   * Keyword (lexical) search over stored chunk content, complementing the
   * embedding-based {@link search}. The file backend scores with BM25 in JS;
   * the Postgres backends use native full-text search. Honors the same
   * {@link VectorSearchFilter} as {@link search} and returns the top-K hits
   * ranked by relevance (`score`), embedding omitted.
   */
  lexicalSearch(query: string, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]>;
}

// ---------------------------------------------------------------------------
// Lexical (BM25) scoring helpers — used by the file backend.
// ---------------------------------------------------------------------------

/** Tokenize: lowercase, split on non-alphanumeric runs, drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Score candidate chunks against a query with Okapi BM25 (k1=1.5, b=0.75),
 * computing IDF over the supplied corpus. Sorts descending and takes top-K.
 * Chunks with a non-positive score are dropped. Returns [] for an empty
 * corpus, empty query, or non-positive topK.
 */
function rankBm25(chunks: StoredChunk[], query: string, topK: number): VectorSearchHit[] {
  const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 0;
  if (limit === 0 || chunks.length === 0) return [];
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const k1 = 1.5;
  const b = 0.75;
  const N = chunks.length;

  // Per-chunk term frequencies + lengths.
  const tfs: Array<Map<string, number>> = new Array(N);
  let totalLength = 0;
  for (let i = 0; i < N; i += 1) {
    const tokens = tokenize(chunks[i]?.content ?? "");
    totalLength += tokens.length;
    const tf = new Map<string, number>();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    tfs[i] = tf;
  }
  const avgdl = totalLength / N;

  // Document frequency per query term -> IDF.
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (let i = 0; i < N; i += 1) {
      if ((tfs[i]?.get(term) ?? 0) > 0) df += 1;
    }
    // BM25 IDF with +1 to stay non-negative even for very common terms.
    idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }

  const scored: VectorSearchHit[] = [];
  for (let i = 0; i < N; i += 1) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const tf = tfs[i] ?? new Map<string, number>();
    let dl = 0;
    for (const c of tf.values()) dl += c;
    let score = 0;
    for (const term of queryTerms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const termIdf = idf.get(term) ?? 0;
      const denom = f + k1 * (1 - b + (b * dl) / (avgdl || 1));
      score += termIdf * ((f * (k1 + 1)) / (denom || 1));
    }
    if (score > 0) scored.push(toHit(chunk, score));
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Cosine similarity of two equal-length vectors. Guards against zero-norm
 * (and mismatched/empty) inputs by returning 0 rather than NaN.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Project a StoredChunk into a search hit (drops the embedding, adds score). */
function toHit(chunk: StoredChunk, score: number): VectorSearchHit {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    score,
    sourceUrl: chunk.sourceUrl,
    finalUrl: chunk.finalUrl,
    title: chunk.title,
    content: chunk.content,
    headingPath: chunk.headingPath,
    anchorId: chunk.anchorId,
    contentHash: chunk.contentHash,
    governanceStatus: chunk.governanceStatus,
    trustScore: chunk.trustScore
  };
}

/**
 * Apply a VectorSearchFilter to a candidate chunk (returns true = keep).
 *
 * Governance is secure-by-default: only `allowed` chunks are returned unless a
 * caller explicitly opts the others back in. `includeUnapproved` re-admits
 * `requires_approval` chunks; `includeBlocked` re-admits `blocked` chunks.
 */
function passesFilter(chunk: StoredChunk, filter?: VectorSearchFilter): boolean {
  if (filter?.url !== undefined && chunk.sourceUrl !== filter.url) return false;
  if (filter?.minTrust !== undefined && chunk.trustScore < filter.minTrust) return false;
  if (chunk.governanceStatus === "blocked") return filter?.includeBlocked === true;
  if (chunk.governanceStatus === "requires_approval") return filter?.includeUnapproved === true;
  return true;
}

/**
 * Build the SQL governance predicate matching {@link passesFilter}: keep only
 * `allowed` unless `includeUnapproved`/`includeBlocked` opt the others in.
 * Returns a single condition string (no params; statuses are literals).
 */
function governanceSqlCondition(filter?: VectorSearchFilter): string {
  const statuses = ["allowed"];
  if (filter?.includeUnapproved) statuses.push("requires_approval");
  if (filter?.includeBlocked) statuses.push("blocked");
  return `governance_status IN (${statuses.map((s) => `'${s}'`).join(", ")})`;
}

/** Score, sort descending, and take the top-K hits. */
function rankTopK(chunks: StoredChunk[], embedding: number[], topK: number): VectorSearchHit[] {
  const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 0;
  if (limit === 0) return [];
  const scored = chunks.map((chunk) => toHit(chunk, cosineSimilarity(embedding, chunk.embedding)));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// File backend
// ---------------------------------------------------------------------------

/**
 * File-backed vector store. All chunks live in a single newline-delimited JSON
 * file (`<dataDir>/vectors.jsonl`), one StoredChunk per line. Writes rewrite
 * the whole file (acceptable for the local/dev scale this backend targets).
 */
class FileVectorStore implements VectorStore {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, "vectors.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  private async readAll(): Promise<StoredChunk[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // Missing store file -> empty.
      return [];
    }
    const chunks: StoredChunk[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as StoredChunk;
        if (parsed && typeof parsed.chunkId === "string" && Array.isArray(parsed.embedding)) {
          chunks.push(parsed);
        }
      } catch {
        // Skip corrupt line; tolerate partial corruption.
      }
    }
    return chunks;
  }

  private async writeAll(chunks: StoredChunk[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const body = chunks.map((c) => JSON.stringify(c)).join("\n");
    await writeFile(this.filePath, body.length ? `${body}\n` : "", "utf8");
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    // Replace ALL existing chunks belonging to any documentId in this batch.
    const incomingDocIds = new Set(chunks.map((c) => c.documentId));
    const existing = await this.readAll();
    const kept = existing.filter((c) => !incomingDocIds.has(c.documentId));
    await this.writeAll([...kept, ...chunks]);
  }

  async deleteByUrl(sourceUrl: string): Promise<void> {
    const existing = await this.readAll();
    const kept = existing.filter((c) => c.sourceUrl !== sourceUrl);
    if (kept.length === existing.length) return;
    await this.writeAll(kept);
  }

  async setGovernanceStatusByUrl(sourceUrl: string, status: GovernanceDecision["status"]): Promise<number> {
    const existing = await this.readAll();
    let updated = 0;
    const next = existing.map((c) => {
      if (c.sourceUrl === sourceUrl && c.governanceStatus !== status) {
        updated += 1;
        return { ...c, governanceStatus: status };
      }
      return c;
    });
    if (updated > 0) await this.writeAll(next);
    return updated;
  }

  async search(embedding: number[], topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    const all = await this.readAll();
    const candidates = all.filter((c) => passesFilter(c, filter));
    return rankTopK(candidates, embedding, topK);
  }

  async lexicalSearch(query: string, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    const all = await this.readAll();
    if (all.length === 0) return [];
    const candidates = all.filter((c) => passesFilter(c, filter));
    return rankBm25(candidates, query, topK);
  }
}

// ---------------------------------------------------------------------------
// SQLite backend
// ---------------------------------------------------------------------------

/** Shape of a row read back from the SQLite `rag_chunks` table. */
interface SqliteRagChunkRow {
  chunk_id: string;
  document_id: string;
  source_url: string;
  final_url: string;
  title: string | null;
  content_hash: string;
  idx: number;
  content: string;
  heading_path: string;
  anchor_id: string | null;
  governance_status: string;
  trust_score: number;
  captured_at: string;
  embedding: Buffer;
}

/** Decode the stored Float32 embedding blob back into a plain number[]. */
function decodeEmbedding(blob: Buffer): number[] {
  // Copy into a fresh, correctly-aligned ArrayBuffer slice before viewing as
  // Float32 — better-sqlite3 buffers are not guaranteed to be 4-byte aligned.
  const floats = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  return Array.from(floats);
}

/** Encode a number[] embedding as Float32Array bytes for BLOB storage. */
function encodeEmbedding(embedding: number[]): Buffer {
  const floats = Float32Array.from(embedding);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function sqliteRowToChunk(row: SqliteRagChunkRow): StoredChunk {
  let headingPath: string[] = [];
  try {
    const parsed = JSON.parse(row.heading_path) as unknown;
    if (Array.isArray(parsed)) headingPath = parsed.map((v) => String(v));
  } catch {
    // Tolerate a corrupt heading_path; treat as empty.
  }
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceUrl: row.source_url,
    finalUrl: row.final_url,
    title: row.title ?? undefined,
    contentHash: row.content_hash,
    index: row.idx,
    content: row.content,
    headingPath,
    anchorId: row.anchor_id ?? undefined,
    governanceStatus: (row.governance_status as StoredChunk["governanceStatus"]) ?? "allowed",
    trustScore: typeof row.trust_score === "number" ? row.trust_score : Number(row.trust_score) || 0,
    capturedAt: row.captured_at,
    embedding: decodeEmbedding(row.embedding)
  };
}

/**
 * SQLite-backed vector store. Chunks live in a `rag_chunks` table with the
 * embedding persisted as a Float32 BLOB; a mirroring `rag_chunks_fts` FTS5
 * virtual table indexes `content` for lexical (bm25) search. Both tables are
 * created on construction and kept in sync inside {@link upsertChunks} and
 * {@link deleteByUrl}.
 *
 * Field parity with {@link FileVectorStore} is exact: every persisted
 * StoredChunk field round-trips. Governance filtering mirrors
 * {@link passesFilter}/{@link governanceSqlCondition} (secure-by-default:
 * only `allowed` unless the caller opts others back in). VECTOR search pulls
 * filtered candidate rows and scores cosine in JS; LEXICAL search ranks by
 * `bm25()` over the FTS table.
 */
class SqliteVectorStore implements VectorStore {
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    this.db = getSqliteDb(config);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS rag_chunks (
         chunk_id TEXT PRIMARY KEY,
         document_id TEXT,
         source_url TEXT,
         final_url TEXT,
         title TEXT,
         content_hash TEXT,
         idx INTEGER,
         content TEXT,
         heading_path TEXT,
         anchor_id TEXT,
         governance_status TEXT,
         trust_score REAL,
         captured_at TEXT,
         embedding BLOB
       );
       CREATE INDEX IF NOT EXISTS rag_chunks_source_url_idx ON rag_chunks (source_url);
       CREATE INDEX IF NOT EXISTS rag_chunks_document_id_idx ON rag_chunks (document_id);
       CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5 (
         chunk_id UNINDEXED,
         content
       );`
    );
  }

  async init(): Promise<void> {
    // Tables are created in the constructor; nothing async to do.
  }

  /**
   * Build the WHERE clause (and positional params) shared by vector and
   * lexical candidate selection. Mirrors passesFilter: url, minTrust, and the
   * secure-by-default governance predicate. `alias` qualifies the columns so
   * the same clause works when joined against the FTS table.
   */
  private buildFilterClause(filter: VectorSearchFilter | undefined, alias = ""): { sql: string; params: unknown[] } {
    const prefix = alias ? `${alias}.` : "";
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.url !== undefined) {
      conditions.push(`${prefix}source_url = ?`);
      params.push(filter.url);
    }
    if (filter?.minTrust !== undefined) {
      conditions.push(`${prefix}trust_score >= ?`);
      params.push(filter.minTrust);
    }
    const statuses = ["allowed"];
    if (filter?.includeUnapproved) statuses.push("requires_approval");
    if (filter?.includeBlocked) statuses.push("blocked");
    conditions.push(`${prefix}governance_status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    return { sql: conditions.join(" AND "), params };
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    // Replace ALL existing chunks belonging to any documentId in this batch,
    // matching the File backend semantics (stale chunks must not linger).
    const incomingDocIds = [...new Set(chunks.map((c) => c.documentId))];

    const selectByDoc = this.db.prepare<[string], { chunk_id: string }>(
      "SELECT chunk_id FROM rag_chunks WHERE document_id = ?"
    );
    const deleteByDoc = this.db.prepare<[string]>("DELETE FROM rag_chunks WHERE document_id = ?");
    const deleteFts = this.db.prepare<[string]>("DELETE FROM rag_chunks_fts WHERE chunk_id = ?");
    const insertChunk = this.db.prepare(
      `INSERT INTO rag_chunks (
         chunk_id, document_id, source_url, final_url, title, content_hash,
         idx, content, heading_path, anchor_id, governance_status,
         trust_score, captured_at, embedding
       ) VALUES (
         @chunk_id, @document_id, @source_url, @final_url, @title, @content_hash,
         @idx, @content, @heading_path, @anchor_id, @governance_status,
         @trust_score, @captured_at, @embedding
       )
       ON CONFLICT (chunk_id) DO UPDATE SET
         document_id = excluded.document_id,
         source_url = excluded.source_url,
         final_url = excluded.final_url,
         title = excluded.title,
         content_hash = excluded.content_hash,
         idx = excluded.idx,
         content = excluded.content,
         heading_path = excluded.heading_path,
         anchor_id = excluded.anchor_id,
         governance_status = excluded.governance_status,
         trust_score = excluded.trust_score,
         captured_at = excluded.captured_at,
         embedding = excluded.embedding`
    );
    const insertFts = this.db.prepare<[string, string]>("INSERT INTO rag_chunks_fts (chunk_id, content) VALUES (?, ?)");

    const run = this.db.transaction((batch: StoredChunk[]) => {
      for (const docId of incomingDocIds) {
        for (const row of selectByDoc.all(docId)) deleteFts.run(row.chunk_id);
        deleteByDoc.run(docId);
      }
      for (const c of batch) {
        // A chunk_id may also be replaced via ON CONFLICT without its document
        // being in the delete set above; clear any stale FTS row for it first.
        deleteFts.run(c.chunkId);
        insertChunk.run({
          chunk_id: c.chunkId,
          document_id: c.documentId,
          source_url: c.sourceUrl,
          final_url: c.finalUrl,
          title: c.title ?? null,
          content_hash: c.contentHash,
          idx: c.index,
          content: c.content,
          heading_path: JSON.stringify(c.headingPath ?? []),
          anchor_id: c.anchorId ?? null,
          governance_status: c.governanceStatus,
          trust_score: c.trustScore,
          captured_at: c.capturedAt,
          embedding: encodeEmbedding(c.embedding ?? [])
        });
        insertFts.run(c.chunkId, c.content);
      }
    });
    run(chunks);
  }

  async deleteByUrl(sourceUrl: string): Promise<void> {
    const selectByUrl = this.db.prepare<[string], { chunk_id: string }>(
      "SELECT chunk_id FROM rag_chunks WHERE source_url = ?"
    );
    const deleteFts = this.db.prepare<[string]>("DELETE FROM rag_chunks_fts WHERE chunk_id = ?");
    const deleteMain = this.db.prepare<[string]>("DELETE FROM rag_chunks WHERE source_url = ?");
    const run = this.db.transaction((url: string) => {
      for (const row of selectByUrl.all(url)) deleteFts.run(row.chunk_id);
      deleteMain.run(url);
    });
    run(sourceUrl);
  }

  async setGovernanceStatusByUrl(sourceUrl: string, status: GovernanceDecision["status"]): Promise<number> {
    const res = this.db
      .prepare<[string, string]>("UPDATE rag_chunks SET governance_status = ? WHERE source_url = ?")
      .run(status, sourceUrl);
    return res.changes;
  }

  async search(embedding: number[], topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    const { sql, params } = this.buildFilterClause(filter);
    const rows = this.db.prepare<unknown[], SqliteRagChunkRow>(`SELECT * FROM rag_chunks WHERE ${sql}`).all(...params);
    const candidates = rows.map(sqliteRowToChunk);
    return rankTopK(candidates, embedding, topK);
  }

  async lexicalSearch(query: string, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 0;
    if (limit === 0) return [];
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const { sql, params } = this.buildFilterClause(filter, "c");
    // Join the FTS match against the main table so the governance/url/minTrust
    // filter applies, ranking by bm25() (lower = better, so order ascending).
    let rows: Array<SqliteRagChunkRow & { score: number }>;
    try {
      rows = this.db
        .prepare<unknown[], SqliteRagChunkRow & { score: number }>(
          `SELECT c.*, bm25(rag_chunks_fts) AS score
             FROM rag_chunks_fts
             JOIN rag_chunks c ON c.chunk_id = rag_chunks_fts.chunk_id
             WHERE rag_chunks_fts MATCH ? AND ${sql}
             ORDER BY score ASC
             LIMIT ?`
        )
        .all(buildFtsMatchQuery(trimmed), ...params, limit);
    } catch {
      // Malformed FTS query (e.g. bare operator characters) -> no matches.
      return [];
    }
    // bm25 returns more-negative for better matches; surface a positive score
    // that sorts the same way (higher = better) for a uniform hit contract.
    return rows.map((row) => toHit(sqliteRowToChunk(row), -row.score));
  }
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: tokenize the same
 * way the lexical scorer does, then OR the quoted terms. This avoids FTS5
 * treating punctuation/operators in raw user input as query syntax.
 */
function buildFtsMatchQuery(query: string): string {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" OR ");
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

/** Shape of a candidate row read back from `rag_chunks`. */
interface RagChunkRow {
  chunk_id: string;
  document_id: string;
  source_url: string;
  final_url: string;
  title: string | null;
  content_hash: string;
  idx: number;
  content: string;
  heading_path: unknown;
  anchor_id: string | null;
  governance_status: string;
  trust_score: number;
  captured_at: Date | string;
  embedding: unknown;
}

function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "number" ? v : Number(v) || 0));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => (typeof v === "number" ? v : Number(v) || 0));
    } catch {
      // fall through
    }
  }
  return [];
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      // fall through
    }
  }
  return [];
}

function rowToChunk(row: RagChunkRow): StoredChunk {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceUrl: row.source_url,
    finalUrl: row.final_url,
    title: row.title ?? undefined,
    contentHash: row.content_hash,
    index: row.idx,
    content: row.content,
    headingPath: toStringArray(row.heading_path),
    anchorId: row.anchor_id ?? undefined,
    governanceStatus: (row.governance_status as StoredChunk["governanceStatus"]) ?? "allowed",
    trustScore: typeof row.trust_score === "number" ? row.trust_score : Number(row.trust_score) || 0,
    capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
    embedding: toNumberArray(row.embedding)
  };
}

/**
 * Postgres-backed vector store. Embeddings are stored as jsonb and cosine
 * similarity is computed in JS over candidate rows (after filtering in SQL).
 * This is intentionally portable across any vanilla Postgres; swapping to
 * pgvector + an ANN index is a drop-in future upgrade for the `search` path.
 */
class PostgresVectorStore implements VectorStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | undefined;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
    // Never let a connection error crash the process at construction time.
    this.pool.on("error", () => {});
  }

  async init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.pool
        .query(
          `CREATE TABLE IF NOT EXISTS rag_chunks (
             chunk_id text PRIMARY KEY,
             document_id text,
             source_url text,
             final_url text,
             title text,
             content_hash text,
             idx int,
             content text,
             heading_path jsonb,
             anchor_id text,
             governance_status text,
             trust_score real,
             captured_at timestamptz,
             embedding jsonb
           )`
        )
        .then(async () => {
          // Best-effort GIN index to accelerate full-text lexical search.
          try {
            await this.pool.query(
              `CREATE INDEX IF NOT EXISTS rag_chunks_content_fts_idx
                 ON rag_chunks USING gin (to_tsvector('english', content))`
            );
          } catch {
            // ignore index-creation failure; sequential scan still works
          }
        })
        .then(() => undefined);
    }
    await this.ready;
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Replace all existing chunks for each affected document, so stale chunks
      // from a re-ingest of the same document do not linger.
      const docIds = [...new Set(chunks.map((c) => c.documentId))];
      await client.query("DELETE FROM rag_chunks WHERE document_id = ANY($1::text[])", [docIds]);
      for (const c of chunks) {
        await client.query(
          `INSERT INTO rag_chunks (
             chunk_id, document_id, source_url, final_url, title, content_hash,
             idx, content, heading_path, anchor_id, governance_status,
             trust_score, captured_at, embedding
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::jsonb
           )
           ON CONFLICT (chunk_id) DO UPDATE SET
             document_id = EXCLUDED.document_id,
             source_url = EXCLUDED.source_url,
             final_url = EXCLUDED.final_url,
             title = EXCLUDED.title,
             content_hash = EXCLUDED.content_hash,
             idx = EXCLUDED.idx,
             content = EXCLUDED.content,
             heading_path = EXCLUDED.heading_path,
             anchor_id = EXCLUDED.anchor_id,
             governance_status = EXCLUDED.governance_status,
             trust_score = EXCLUDED.trust_score,
             captured_at = EXCLUDED.captured_at,
             embedding = EXCLUDED.embedding`,
          [
            c.chunkId,
            c.documentId,
            c.sourceUrl,
            c.finalUrl,
            c.title ?? null,
            c.contentHash,
            c.index,
            c.content,
            JSON.stringify(c.headingPath ?? []),
            c.anchorId ?? null,
            c.governanceStatus,
            c.trustScore,
            c.capturedAt,
            JSON.stringify(c.embedding ?? [])
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteByUrl(sourceUrl: string): Promise<void> {
    await this.init();
    await this.pool.query("DELETE FROM rag_chunks WHERE source_url = $1", [sourceUrl]);
  }

  async setGovernanceStatusByUrl(sourceUrl: string, status: GovernanceDecision["status"]): Promise<number> {
    await this.init();
    const res = await this.pool.query("UPDATE rag_chunks SET governance_status = $2 WHERE source_url = $1", [
      sourceUrl,
      status
    ]);
    return res.rowCount ?? 0;
  }

  async search(embedding: number[], topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    await this.init();
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.url !== undefined) {
      params.push(filter.url);
      conditions.push(`source_url = $${params.length}`);
    }
    if (filter?.minTrust !== undefined) {
      params.push(filter.minTrust);
      conditions.push(`trust_score >= $${params.length}`);
    }
    conditions.push(governanceSqlCondition(filter));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const res = await this.pool.query<RagChunkRow>(`SELECT * FROM rag_chunks ${where}`, params);
    const candidates = res.rows.map(rowToChunk);
    return rankTopK(candidates, embedding, topK);
  }

  async lexicalSearch(query: string, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    await this.init();
    const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 0;
    if (limit === 0) return [];
    // $1 is the query text used in both the rank and the match predicate.
    const params: unknown[] = [query];
    const conditions: string[] = [`to_tsvector('english', content) @@ plainto_tsquery('english', $1)`];
    if (filter?.url !== undefined) {
      params.push(filter.url);
      conditions.push(`source_url = $${params.length}`);
    }
    if (filter?.minTrust !== undefined) {
      params.push(filter.minTrust);
      conditions.push(`trust_score >= $${params.length}`);
    }
    conditions.push(governanceSqlCondition(filter));
    params.push(limit);
    const limitParam = `$${params.length}`;
    const res = await this.pool.query<RagChunkVecRow>(
      `SELECT *, ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) AS score
         FROM rag_chunks
         WHERE ${conditions.join(" AND ")}
         ORDER BY score DESC
         LIMIT ${limitParam}`,
      params
    );
    return res.rows.map((row) => {
      const score = typeof row.score === "number" ? row.score : Number(row.score) || 0;
      return toHit(rowToChunk(row), score);
    });
  }
}

// ---------------------------------------------------------------------------
// pgvector backend
// ---------------------------------------------------------------------------

/** Row read back from `rag_chunks_vec`. `score` is present only on search. */
interface RagChunkVecRow extends RagChunkRow {
  score?: number | string;
}

/** Format a JS number[] as a pgvector literal, e.g. "[1,2,3]". */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}

/**
 * pgvector-backed vector store. Embeddings live in a native `vector(dim)`
 * column and similarity search is delegated to pgvector's cosine-distance
 * operator (`<=>`) with an ANN index, instead of scoring in JS.
 *
 * The column dimension is fixed once (from `config.vectorDim` or the first
 * upserted vector's length). The table is created lazily on first upsert,
 * because the dimension is unknown until then; `init()` only enables the
 * extension. If the `vector` extension is unavailable (not installed / no
 * permission), {@link unavailable} is set and callers should fall back to the
 * jsonb {@link PostgresVectorStore}.
 */
class PgvectorVectorStore implements VectorStore {
  private readonly pool: pg.Pool;
  private readonly forcedDim: number | undefined;
  private initialized: Promise<void> | undefined;
  /** Set when CREATE EXTENSION failed; signals callers to use the jsonb store. */
  unavailable = false;
  /** The fixed embedding dimension once a table exists. */
  private dim: number | undefined;
  private tableReady: Promise<void> | undefined;

  constructor(databaseUrl: string, forcedDim?: number) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
    this.pool.on("error", () => {});
    this.forcedDim = forcedDim;
  }

  async init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.pool
        .query("CREATE EXTENSION IF NOT EXISTS vector")
        .then(() => undefined)
        .catch(() => {
          // Extension unavailable / insufficient privilege: degrade to jsonb.
          this.unavailable = true;
        });
    }
    await this.initialized;
  }

  /** Lazily create the table (and a best-effort ANN index) for `dim`. */
  private async ensureTable(dim: number): Promise<void> {
    if (this.dim === undefined) {
      this.dim = dim;
    } else if (this.dim !== dim) {
      throw new Error(
        `pgvector dimension mismatch: table is vector(${this.dim}) but received a vector of length ${dim}`
      );
    }
    if (!this.tableReady) {
      const fixedDim = this.dim;
      this.tableReady = (async () => {
        await this.pool.query(
          `CREATE TABLE IF NOT EXISTS rag_chunks_vec (
             chunk_id text PRIMARY KEY,
             document_id text,
             source_url text,
             final_url text,
             title text,
             content_hash text,
             idx int,
             content text,
             heading_path jsonb,
             anchor_id text,
             governance_status text,
             trust_score real,
             captured_at timestamptz,
             embedding vector(${fixedDim})
           )`
        );
        // Best-effort ANN index. Prefer HNSW (good recall regardless of row
        // count); fall back to ivfflat on older pgvector that lacks HNSW.
        try {
          await this.pool.query(
            `CREATE INDEX IF NOT EXISTS rag_chunks_vec_embedding_idx
               ON rag_chunks_vec USING hnsw (embedding vector_cosine_ops)`
          );
        } catch {
          try {
            await this.pool.query(
              `CREATE INDEX IF NOT EXISTS rag_chunks_vec_embedding_idx
                 ON rag_chunks_vec USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
            );
          } catch {
            // ignore index-creation errors; sequential scan still works
          }
        }
        // Best-effort GIN index to accelerate full-text lexical search.
        try {
          await this.pool.query(
            `CREATE INDEX IF NOT EXISTS rag_chunks_vec_content_fts_idx
               ON rag_chunks_vec USING gin (to_tsvector('english', content))`
          );
        } catch {
          // ignore index-creation failure; sequential scan still works
        }
      })();
    }
    await this.tableReady;
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.init();
    const first = chunks[0];
    const inferred = this.forcedDim ?? this.dim ?? (first ? first.embedding.length : 0);
    if (inferred <= 0) {
      throw new Error("pgvector upsert: cannot determine embedding dimension (empty vector)");
    }
    await this.ensureTable(inferred);
    const expected = this.dim ?? inferred;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Replace all existing chunks for each affected document, so stale chunks
      // from a re-ingest of the same document do not linger.
      const docIds = [...new Set(chunks.map((c) => c.documentId))];
      await client.query("DELETE FROM rag_chunks_vec WHERE document_id = ANY($1::text[])", [docIds]);
      for (const c of chunks) {
        const embedding = c.embedding ?? [];
        if (embedding.length !== expected) {
          throw new Error(
            `pgvector dimension mismatch: table is vector(${expected}) but chunk ${c.chunkId} has length ${embedding.length}`
          );
        }
        await client.query(
          `INSERT INTO rag_chunks_vec (
             chunk_id, document_id, source_url, final_url, title, content_hash,
             idx, content, heading_path, anchor_id, governance_status,
             trust_score, captured_at, embedding
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14::vector
           )
           ON CONFLICT (chunk_id) DO UPDATE SET
             document_id = EXCLUDED.document_id,
             source_url = EXCLUDED.source_url,
             final_url = EXCLUDED.final_url,
             title = EXCLUDED.title,
             content_hash = EXCLUDED.content_hash,
             idx = EXCLUDED.idx,
             content = EXCLUDED.content,
             heading_path = EXCLUDED.heading_path,
             anchor_id = EXCLUDED.anchor_id,
             governance_status = EXCLUDED.governance_status,
             trust_score = EXCLUDED.trust_score,
             captured_at = EXCLUDED.captured_at,
             embedding = EXCLUDED.embedding`,
          [
            c.chunkId,
            c.documentId,
            c.sourceUrl,
            c.finalUrl,
            c.title ?? null,
            c.contentHash,
            c.index,
            c.content,
            JSON.stringify(c.headingPath ?? []),
            c.anchorId ?? null,
            c.governanceStatus,
            c.trustScore,
            c.capturedAt,
            toVectorLiteral(embedding)
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteByUrl(sourceUrl: string): Promise<void> {
    await this.init();
    // No table yet => nothing to delete.
    if (!this.tableReady) return;
    await this.tableReady;
    await this.pool.query("DELETE FROM rag_chunks_vec WHERE source_url = $1", [sourceUrl]);
  }

  async setGovernanceStatusByUrl(sourceUrl: string, status: GovernanceDecision["status"]): Promise<number> {
    await this.init();
    // No table yet => nothing to update.
    if (!this.tableReady) return 0;
    await this.tableReady;
    const res = await this.pool.query("UPDATE rag_chunks_vec SET governance_status = $2 WHERE source_url = $1", [
      sourceUrl,
      status
    ]);
    return res.rowCount ?? 0;
  }

  async search(embedding: number[], topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    await this.init();
    const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 0;
    if (limit === 0) return [];
    // Ensure the table exists for THIS process. `tableReady` is per-process
    // in-memory state set during upsert; a search-only process (e.g. a query
    // server separate from the ingest worker) never upserts, so we derive the
    // dimension from the query vector and lazily ensure the (idempotent) table.
    const dim = this.forcedDim ?? embedding.length;
    if (dim <= 0) return [];
    await this.ensureTable(dim);

    const params: unknown[] = [toVectorLiteral(embedding)];
    const vecParam = "$1::vector";
    const conditions: string[] = [];
    if (filter?.url !== undefined) {
      params.push(filter.url);
      conditions.push(`source_url = $${params.length}`);
    }
    if (filter?.minTrust !== undefined) {
      params.push(filter.minTrust);
      conditions.push(`trust_score >= $${params.length}`);
    }
    conditions.push(governanceSqlCondition(filter));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const limitParam = `$${params.length}`;
    const res = await this.pool.query<RagChunkVecRow>(
      `SELECT *, (1 - (embedding <=> ${vecParam})) AS score
         FROM rag_chunks_vec
         ${where}
         ORDER BY embedding <=> ${vecParam}
         LIMIT ${limitParam}`,
      params
    );
    return res.rows.map((row) => {
      const score = typeof row.score === "number" ? row.score : Number(row.score) || 0;
      return toHit(rowToChunk(row), score);
    });
  }

  async lexicalSearch(query: string, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    await this.init();
    const limit = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 0;
    if (limit === 0) return [];
    // Lexical search needs the table but has no embedding to infer its
    // dimension from. If no upsert has created the table in this process, and
    // we have no forced dimension to ensure it with, there is nothing to query.
    if (!this.tableReady) {
      if (this.forcedDim !== undefined && this.forcedDim > 0) {
        await this.ensureTable(this.forcedDim);
      } else {
        return [];
      }
    }
    await this.tableReady;

    const params: unknown[] = [query];
    const conditions: string[] = [`to_tsvector('english', content) @@ plainto_tsquery('english', $1)`];
    if (filter?.url !== undefined) {
      params.push(filter.url);
      conditions.push(`source_url = $${params.length}`);
    }
    if (filter?.minTrust !== undefined) {
      params.push(filter.minTrust);
      conditions.push(`trust_score >= $${params.length}`);
    }
    conditions.push(governanceSqlCondition(filter));
    params.push(limit);
    const limitParam = `$${params.length}`;
    const res = await this.pool.query<RagChunkVecRow>(
      `SELECT *, ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) AS score
         FROM rag_chunks_vec
         WHERE ${conditions.join(" AND ")}
         ORDER BY score DESC
         LIMIT ${limitParam}`,
      params
    );
    return res.rows.map((row) => {
      const score = typeof row.score === "number" ? row.score : Number(row.score) || 0;
      return toHit(rowToChunk(row), score);
    });
  }
}

/**
 * Backend selector used when a `databaseUrl` is configured. It prefers
 * {@link PgvectorVectorStore} but transparently delegates to the jsonb
 * {@link PostgresVectorStore} when the `vector` extension is unavailable.
 *
 * Keeps {@link getVectorStore} synchronous: the real backend is decided on the
 * first `init()` (the only place we can probe the DB) and reused thereafter.
 */
class PostgresBackedVectorStore implements VectorStore {
  private readonly pgvector: PgvectorVectorStore;
  private readonly jsonb: PostgresVectorStore;
  private chosen: VectorStore | undefined;
  private selecting: Promise<VectorStore> | undefined;

  constructor(databaseUrl: string, forcedDim?: number) {
    this.pgvector = new PgvectorVectorStore(databaseUrl, forcedDim);
    this.jsonb = new PostgresVectorStore(databaseUrl);
  }

  /** Probe pgvector once; fall back to jsonb if the extension is unavailable. */
  private async select(): Promise<VectorStore> {
    if (this.chosen) return this.chosen;
    if (!this.selecting) {
      this.selecting = (async () => {
        await this.pgvector.init();
        if (this.pgvector.unavailable) {
          await this.jsonb.init();
          this.chosen = this.jsonb;
        } else {
          this.chosen = this.pgvector;
        }
        return this.chosen;
      })();
    }
    return this.selecting;
  }

  async init(): Promise<void> {
    await this.select();
  }

  async upsertChunks(chunks: StoredChunk[]): Promise<void> {
    return (await this.select()).upsertChunks(chunks);
  }

  async deleteByUrl(sourceUrl: string): Promise<void> {
    return (await this.select()).deleteByUrl(sourceUrl);
  }

  async setGovernanceStatusByUrl(sourceUrl: string, status: GovernanceDecision["status"]): Promise<number> {
    return (await this.select()).setGovernanceStatusByUrl(sourceUrl, status);
  }

  async search(embedding: number[], topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    return (await this.select()).search(embedding, topK, filter);
  }

  async lexicalSearch(query: string, topK: number, filter?: VectorSearchFilter): Promise<VectorSearchHit[]> {
    return (await this.select()).lexicalSearch(query, topK, filter);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let store: VectorStore | undefined;

/**
 * Returns the active vector store as a process-wide singleton. When
 * `config.databaseUrl` is set, returns a store that PREFERS pgvector but falls
 * back to the jsonb Postgres backend if the `vector` extension is unavailable
 * (the choice is made on the first `init()` so this factory stays synchronous).
 * Otherwise the file backend rooted at `config.dataDir`. Never throws at import
 * or call time: any configuration error falls back to the file backend.
 */
export function getVectorStore(): VectorStore {
  if (!store) {
    try {
      const config = loadConfig();
      if (config.databaseUrl) {
        store = new PostgresBackedVectorStore(config.databaseUrl, config.vectorDim);
      } else if (resolveStorageBackend(config) === "file") {
        store = new FileVectorStore(config.dataDir);
      } else {
        store = new SqliteVectorStore(config);
      }
    } catch {
      // Last-resort fallback so callers always get a usable store.
      store = new FileVectorStore(".octoryn-scout");
    }
  }
  return store;
}
