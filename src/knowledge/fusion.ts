import type { VectorSearchHit } from "../types.js";

/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Combines several independently-ranked hit lists into a single ranking. For
 * each list, a hit at 0-based rank `r` contributes `1 / (k + r + 1)` to its
 * fused score (default `k = 60`, the value from the original Cormack et al.
 * RRF paper). Contributions are accumulated per `chunkId` across all lists.
 *
 * The first-seen hit object for a given `chunkId` is kept (its `score` field is
 * replaced with the summed RRF score). The result is deduplicated by `chunkId`
 * and sorted by fused score descending. Pure and deterministic.
 */
export function reciprocalRankFusion(lists: VectorSearchHit[][], opts?: { k?: number }): VectorSearchHit[] {
  const k = opts?.k ?? 60;

  const fusedScore = new Map<string, number>();
  const firstSeen = new Map<string, VectorSearchHit>();
  const order: string[] = [];

  for (const list of lists) {
    for (let r = 0; r < list.length; r += 1) {
      const hit = list[r];
      const contribution = 1 / (k + r + 1);
      const prev = fusedScore.get(hit.chunkId);
      if (prev === undefined) {
        fusedScore.set(hit.chunkId, contribution);
        firstSeen.set(hit.chunkId, hit);
        order.push(hit.chunkId);
      } else {
        fusedScore.set(hit.chunkId, prev + contribution);
      }
    }
  }

  return order
    .map((chunkId) => {
      const hit = firstSeen.get(chunkId)!;
      return { ...hit, score: fusedScore.get(chunkId)! };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Keep the first occurrence of each `chunkId`, preserving input order.
 */
export function dedupeByChunkId(hits: VectorSearchHit[]): VectorSearchHit[] {
  const seen = new Set<string>();
  const out: VectorSearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.chunkId)) continue;
    seen.add(hit.chunkId);
    out.push(hit);
  }
  return out;
}
