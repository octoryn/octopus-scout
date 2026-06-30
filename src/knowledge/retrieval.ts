import { loadConfig } from "../config.js";
import { scrapeUrl } from "../ingest/pipeline.js";
import { buildRagDocument } from "./ragExport.js";
import { getEmbeddingProvider } from "./embedding.js";
import { getVectorStore } from "./vectorStore.js";
import { reciprocalRankFusion, dedupeByChunkId } from "./fusion.js";
import { getReranker } from "./reranker.js";
import type {
  EmbeddedChunk,
  IngestResult,
  RagDocument,
  RetrievalMode,
  StoredChunk,
  VectorSearchFilter,
  VectorSearchHit,
  VectorSearchResult
} from "../types.js";

/**
 * Retrieval orchestration: the write-path (ingestUrl) and read-path
 * (searchKnowledge) that tie scraping + chunking + embedding to the vector
 * store. Both functions degrade gracefully: a blocked source is skipped rather
 * than indexed, and an embedding provider that returns nothing yields an empty
 * (but well-formed) result rather than throwing.
 */

export interface IngestUrlInput {
  url: string;
  maxTokens?: number;
  overlapTokens?: number;
  forceRefresh?: boolean;
}

export interface SearchKnowledgeInput {
  query: string;
  topK?: number;
  url?: string;
  minTrust?: number;
  includeBlocked?: boolean;
  includeUnapproved?: boolean;
  mode?: RetrievalMode;
  rerank?: boolean;
  rewrite?: boolean;
}

/**
 * Common English stopwords dropped when producing the keyword-only variant.
 * Deliberately small and curated: enough to strip filler ("what", "is", "the")
 * without gutting short queries.
 */
const STOPWORDS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with"
]);

/**
 * Produce a small, ordered, deduplicated set of query variants for retrieval.
 *
 * Heuristic only — no LLM, no network, fully deterministic and dependency-free.
 * The returned variants, in order, are:
 *  1. the original query (verbatim, trimmed only if it is all whitespace);
 *  2. a normalized form: lowercased, punctuation stripped, whitespace collapsed;
 *  3. a keyword-only expansion: the normalized tokens with common stopwords
 *     removed (only when this differs from the normalized form and is non-empty).
 *
 * Variants are deduplicated (preserving first-seen order) so an already-normal,
 * stopword-free query collapses to a single entry. An empty/whitespace query
 * yields an empty array.
 */
export function rewriteQuery(query: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    variants.push(value);
  };

  const original = query.trim();
  if (original.length === 0) return [];
  push(original);

  // Normalize: lowercase, strip punctuation to spaces, collapse whitespace.
  const normalized = original
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  push(normalized);

  // Keyword-only expansion: drop stopwords from the normalized tokens.
  const keywords = normalized.split(" ").filter((token) => token.length > 0 && !STOPWORDS.has(token));
  if (keywords.length > 0) {
    push(keywords.join(" "));
  }

  return variants;
}

/** Project the document's embedded chunks into StoredChunk rows for upsert. */
function toStoredChunks(doc: RagDocument, sourceUrl: string, finalUrl: string): StoredChunk[] {
  return doc.chunks.map((chunk: EmbeddedChunk) => ({
    chunkId: chunk.id,
    documentId: doc.id,
    sourceUrl,
    finalUrl,
    title: doc.title,
    contentHash: doc.contentHash,
    index: chunk.index,
    content: chunk.content,
    headingPath: chunk.headingPath,
    anchorId: chunk.anchorId,
    governanceStatus: doc.governance.status,
    trustScore: doc.trust.score,
    capturedAt: doc.capturedAt,
    embedding: chunk.embedding ?? []
  }));
}

/**
 * Scrape a URL, chunk + embed it, and (re-)index it into the vector store.
 *
 * Governance-blocked sources are never indexed: the function returns an
 * IngestResult with `skipped: true` and `chunksIndexed: 0`. Otherwise the
 * source's existing chunks are deleted first (so a re-ingest replaces stale
 * chunks cleanly) before the freshly embedded chunks are upserted.
 */
export async function ingestUrl(input: IngestUrlInput): Promise<IngestResult> {
  const config = loadConfig();
  const result = await scrapeUrl({ url: input.url, forceRefresh: input.forceRefresh });

  const sourceUrl = result.request.url;
  const finalUrl = result.fetch.finalUrl;
  const contentHash = result.evidence.contentHash;

  if (result.evidence.governance.status === "blocked") {
    return {
      documentId: "",
      sourceUrl,
      finalUrl,
      contentHash,
      chunksIndexed: 0,
      governanceStatus: "blocked",
      skipped: true,
      reason: "blocked by governance"
    };
  }

  // ENFORCE vs FLAG: in "enforce" mode, content that requires approval is
  // quarantined (never indexed) until a human approves it. In "flag"/"off"
  // mode it IS indexed, but the default search filter (allowed-only) keeps it
  // out of results until it is approved.
  if (result.evidence.governance.status === "requires_approval" && config.approvalMode === "enforce") {
    return {
      documentId: "",
      sourceUrl,
      finalUrl,
      contentHash,
      chunksIndexed: 0,
      governanceStatus: "requires_approval",
      skipped: true,
      reason: "requires approval (enforce mode)"
    };
  }

  const doc = await buildRagDocument(result, {
    maxTokens: input.maxTokens,
    overlapTokens: input.overlapTokens,
    embed: true
  });

  const stored = toStoredChunks(doc, sourceUrl, finalUrl);

  const store = getVectorStore();
  await store.init();
  // Re-index cleanly: drop any prior chunks for this source before upserting.
  await store.deleteByUrl(sourceUrl);
  await store.upsertChunks(stored);

  return {
    documentId: doc.id,
    sourceUrl,
    finalUrl,
    contentHash,
    chunksIndexed: stored.length,
    governanceStatus: doc.governance.status,
    skipped: false
  };
}

/**
 * Retrieve the top-K most relevant indexed chunks for a query, optionally
 * filtered by source URL, minimum trust score, and governance status.
 *
 * The candidate set is built according to the resolved retrieval mode
 * (input.mode ?? config.retrievalMode):
 *  - "vector":  embed the query and run a similarity search.
 *  - "lexical": run a keyword (BM25 / full-text) search; no embedding needed.
 *  - "hybrid":  run BOTH and fuse them with Reciprocal Rank Fusion.
 *
 * The fused/single candidate list is then optionally reranked (input.rerank ??
 * config.rerankProvider !== "none") and truncated to topK.
 *
 * Degrades gracefully: an empty query embedding (vector/hybrid) or an empty
 * corpus yields an empty (but well-formed) result rather than throwing.
 */
export async function searchKnowledge(input: SearchKnowledgeInput): Promise<VectorSearchResult> {
  const topK = input.topK ?? 5;
  const config = loadConfig();
  const mode: RetrievalMode = input.mode ?? config.retrievalMode;

  // Query rewriting (opt-in): expand the query into heuristic variants, run a
  // (non-rewriting) search for each, and FUSE the candidate hit lists with the
  // same reciprocal-rank-fusion used for hybrid retrieval, then take topK. With
  // a single variant this is a no-op fusion, so behavior matches a plain search.
  if (input.rewrite) {
    const variants = rewriteQuery(input.query);
    if (variants.length > 1) {
      const lists = await Promise.all(
        variants.map((variant) => searchKnowledge({ ...input, query: variant, rewrite: false, topK }))
      );
      const fused = reciprocalRankFusion(lists.map((result) => result.hits));
      return { query: input.query, topK, hits: fused.slice(0, topK) };
    }
  }

  const filter: VectorSearchFilter = {
    url: input.url,
    minTrust: input.minTrust,
    includeBlocked: input.includeBlocked,
    includeUnapproved: input.includeUnapproved
  };

  const store = getVectorStore();
  await store.init();

  // Over-fetch candidates so fusion/rerank have headroom to reorder.
  const candidateK = Math.max(topK * 3, 20);

  let candidates: VectorSearchHit[];

  if (mode === "lexical") {
    candidates = await store.lexicalSearch(input.query, candidateK, filter);
  } else if (mode === "hybrid") {
    const vector = await embedQuery(input.query);
    const vectorHits = vector ? await store.search(vector, candidateK, filter) : [];
    const lexicalHits = await store.lexicalSearch(input.query, candidateK, filter);
    candidates = reciprocalRankFusion([vectorHits, lexicalHits]);
  } else {
    // "vector"
    const vector = await embedQuery(input.query);
    if (!vector) {
      return { query: input.query, topK, hits: [] };
    }
    candidates = await store.search(vector, candidateK, filter);
  }

  candidates = dedupeByChunkId(candidates);

  const doRerank = input.rerank ?? config.rerankProvider !== "none";
  const hits = doRerank ? await getReranker().rerank(input.query, candidates, topK) : candidates.slice(0, topK);

  return { query: input.query, topK, hits };
}

/**
 * Embed a single query string, returning the vector or `undefined` when the
 * active embedding provider yields nothing usable (e.g. an empty/failed embed).
 */
async function embedQuery(query: string): Promise<number[] | undefined> {
  const provider = getEmbeddingProvider();
  const vectors = await provider.embed([query]);
  const vector = vectors[0];
  if (!vector || vector.length === 0) {
    return undefined;
  }
  return vector;
}
