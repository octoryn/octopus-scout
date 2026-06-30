import { loadConfig } from "../config.js";
import type { RerankProvider, VectorSearchHit } from "../types.js";

/**
 * Pluggable reranker: a second-stage scorer applied to a candidate set of
 * {@link VectorSearchHit}s before they are returned to the caller.
 *
 * Backends:
 *  - {@link HeuristicReranker} (default): deterministic, network-free blend of
 *    the incoming score, lexical overlap, a heading bonus, and trust.
 *  - {@link CohereReranker} / {@link VoyageReranker}: cross-encoder rerank APIs,
 *    selected by config only when the matching API key is present.
 *  - {@link NoopReranker}: identity (truncate to top-K), used when reranking is
 *    explicitly disabled.
 *
 * {@link getReranker} never throws: a missing API key silently falls back to
 * the heuristic, so the read-path always has a working reranker.
 */

const QUERY_TOKEN_RE = /[^a-z0-9]+/;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(QUERY_TOKEN_RE)
    .filter((t) => t.length > 0);
}

function distinctTerms(query: string): string[] {
  return Array.from(new Set(tokenize(query)));
}

/**
 * Deterministic, network-free reranker. Scores each hit by a blend of:
 *  (a) its incoming score, min-max normalized to [0,1] across the batch;
 *  (b) lexical overlap: fraction of distinct query terms present in
 *      (content + headingPath joined);
 *  (c) a heading bonus when any query term appears in the heading path;
 *  (d) trustScore.
 */
export class HeuristicReranker implements RerankProvider {
  readonly name = "heuristic";

  async rerank(query: string, hits: VectorSearchHit[], topK: number): Promise<VectorSearchHit[]> {
    if (hits.length === 0) return [];

    const terms = distinctTerms(query);

    // Min-max normalize the incoming scores across the batch to [0,1].
    let min = Infinity;
    let max = -Infinity;
    for (const hit of hits) {
      if (hit.score < min) min = hit.score;
      if (hit.score > max) max = hit.score;
    }
    const range = max - min;

    const scored = hits.map((hit, idx) => {
      const incoming = range > 0 ? (hit.score - min) / range : 1;

      const headingText = hit.headingPath.join(" ");
      const haystack = tokenize(`${hit.content} ${headingText}`);
      const haystackSet = new Set(haystack);
      const headingSet = new Set(tokenize(headingText));

      let matched = 0;
      let headingMatch = false;
      for (const term of terms) {
        if (haystackSet.has(term)) matched += 1;
        if (headingSet.has(term)) headingMatch = true;
      }
      const overlap = terms.length > 0 ? matched / terms.length : 0;
      const headingBonus = headingMatch ? 1 : 0;
      const trust = clamp01(hit.trustScore);

      const blended = 0.5 * incoming + 0.35 * overlap + 0.1 * headingBonus + 0.05 * trust;
      return { hit, blended, idx };
    });

    // Stable sort: descending by blended score, ties broken by original index.
    scored.sort((a, b) => b.blended - a.blended || a.idx - b.idx);

    return scored.slice(0, Math.max(0, topK)).map(({ hit, blended }) => ({ ...hit, score: blended }));
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Identity reranker used when reranking is disabled. Returns the first `topK`
 * hits unchanged (order and scores preserved).
 */
export class NoopReranker implements RerankProvider {
  readonly name = "none";

  async rerank(_query: string, hits: VectorSearchHit[], topK: number): Promise<VectorSearchHit[]> {
    return hits.slice(0, Math.max(0, topK));
  }
}

interface RerankApiResult {
  index: number;
  relevance_score: number;
}

function reorderByApiResults(hits: VectorSearchHit[], results: RerankApiResult[], topK: number): VectorSearchHit[] {
  const out: VectorSearchHit[] = [];
  for (const r of results) {
    const hit = hits[r.index];
    if (!hit) continue;
    out.push({ ...hit, score: r.relevance_score });
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * Cohere Rerank v2 cross-encoder. POSTs the candidate documents to the Cohere
 * API and reorders hits by the returned relevance scores.
 */
export class CohereReranker implements RerankProvider {
  readonly name = "cohere";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "rerank-v3.5";
  }

  async rerank(query: string, hits: VectorSearchHit[], topK: number): Promise<VectorSearchHit[]> {
    if (hits.length === 0) return [];

    const res = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: hits.map((h) => h.content),
        top_n: topK
      }),
      signal: AbortSignal.timeout(15_000)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Cohere rerank failed (${res.status} ${res.statusText}): ${detail.slice(0, 500)}`);
    }

    const json = (await res.json()) as { results?: RerankApiResult[] };
    const results = Array.isArray(json.results) ? json.results : [];
    return reorderByApiResults(hits, results, topK);
  }
}

/**
 * Voyage AI reranker cross-encoder. POSTs the candidate documents to the Voyage
 * API and reorders hits by the returned relevance scores.
 */
export class VoyageReranker implements RerankProvider {
  readonly name = "voyage";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "rerank-2.5";
  }

  async rerank(query: string, hits: VectorSearchHit[], topK: number): Promise<VectorSearchHit[]> {
    if (hits.length === 0) return [];

    const res = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        documents: hits.map((h) => h.content),
        model: this.model,
        top_k: topK
      }),
      signal: AbortSignal.timeout(15_000)
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Voyage rerank failed (${res.status} ${res.statusText}): ${detail.slice(0, 500)}`);
    }

    const json = (await res.json()) as { data?: RerankApiResult[] };
    const results = Array.isArray(json.data) ? json.data : [];
    return reorderByApiResults(hits, results, topK);
  }
}

/**
 * Select the reranker backend from config. Never throws: if a remote backend is
 * configured but its API key is missing, falls back to the heuristic reranker.
 */
export function getReranker(): RerankProvider {
  const config = loadConfig();

  switch (config.rerankProvider) {
    case "cohere":
      if (config.cohereApiKey) {
        return new CohereReranker(config.cohereApiKey, config.rerankModel);
      }
      return new HeuristicReranker();
    case "voyage":
      if (config.voyageApiKey) {
        return new VoyageReranker(config.voyageApiKey, config.rerankModel);
      }
      return new HeuristicReranker();
    case "none":
      return new NoopReranker();
    default:
      return new HeuristicReranker();
  }
}
