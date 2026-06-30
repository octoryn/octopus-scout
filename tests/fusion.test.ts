import { describe, it, expect } from "vitest";
import { reciprocalRankFusion, dedupeByChunkId } from "../src/knowledge/fusion.js";
import type { VectorSearchHit } from "../src/types.js";

function makeHit(chunkId: string, score: number, content?: string): VectorSearchHit {
  return {
    chunkId,
    documentId: `doc-${chunkId}`,
    score,
    sourceUrl: `https://example.test/${chunkId}`,
    finalUrl: `https://example.test/${chunkId}`,
    title: `Title ${chunkId}`,
    content: content ?? `content for ${chunkId}`,
    headingPath: ["root", chunkId],
    contentHash: `hash-${chunkId}`,
    governanceStatus: "allowed",
    trustScore: 0.5
  };
}

describe("reciprocalRankFusion", () => {
  it("ranks a chunk high in both lists above one high in only a single list", () => {
    // "shared" is rank 0 in both lists; "soloA"/"soloB" are rank 0 in only one.
    const listA = [makeHit("shared", 0.9), makeHit("soloA", 0.8)];
    const listB = [makeHit("shared", 0.95), makeHit("soloB", 0.85)];

    const fused = reciprocalRankFusion([listA, listB]);

    expect(fused[0].chunkId).toBe("shared");
    // shared appears at rank 0 in both, so it must outrank either solo hit.
    const sharedScore = fused.find((h) => h.chunkId === "shared")!.score;
    const soloAScore = fused.find((h) => h.chunkId === "soloA")!.score;
    const soloBScore = fused.find((h) => h.chunkId === "soloB")!.score;
    expect(sharedScore).toBeGreaterThan(soloAScore);
    expect(sharedScore).toBeGreaterThan(soloBScore);
  });

  it("dedupes by chunkId in the fused output", () => {
    const listA = [makeHit("a", 0.9), makeHit("b", 0.8)];
    const listB = [makeHit("a", 0.7), makeHit("b", 0.6)];

    const fused = reciprocalRankFusion([listA, listB]);

    const ids = fused.map((h) => h.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["a", "b"]);
  });

  it("sets the fused score to the summed RRF contribution (default k=60)", () => {
    const k = 60;
    // "shared" at rank 0 in both lists => 1/(k+1) + 1/(k+1).
    // "soloB" at rank 1 in second list => 1/(k+2).
    const listA = [makeHit("shared", 0.9)];
    const listB = [makeHit("shared", 0.95), makeHit("soloB", 0.85)];

    const fused = reciprocalRankFusion([listA, listB]);

    const shared = fused.find((h) => h.chunkId === "shared")!;
    const soloB = fused.find((h) => h.chunkId === "soloB")!;

    const expectedShared = 1 / (k + 0 + 1) + 1 / (k + 0 + 1);
    const expectedSoloB = 1 / (k + 1 + 1);
    expect(shared.score).toBeCloseTo(expectedShared, 12);
    expect(soloB.score).toBeCloseTo(expectedSoloB, 12);
  });

  it("keeps the first-seen hit object's fields while replacing score", () => {
    const listA = [makeHit("a", 0.11, "FIRST content")];
    const listB = [makeHit("a", 0.99, "SECOND content")];

    const fused = reciprocalRankFusion([listA, listB]);

    expect(fused).toHaveLength(1);
    // First-seen content is retained; only score is overwritten.
    expect(fused[0].content).toBe("FIRST content");
    expect(fused[0].score).toBeCloseTo(2 / 61, 12);
  });

  it("changes weighting when k changes", () => {
    const listA = [makeHit("top", 0.9), makeHit("low", 0.1)];

    const small = reciprocalRankFusion([listA], { k: 1 });
    const large = reciprocalRankFusion([listA], { k: 1000 });

    // Smaller k accentuates the gap between rank 0 and rank 1.
    const smallTop = small.find((h) => h.chunkId === "top")!.score;
    const smallLow = small.find((h) => h.chunkId === "low")!.score;
    const largeTop = large.find((h) => h.chunkId === "top")!.score;
    const largeLow = large.find((h) => h.chunkId === "low")!.score;

    expect(smallTop).toBeCloseTo(1 / 2, 12);
    expect(smallLow).toBeCloseTo(1 / 3, 12);
    expect(largeTop).toBeCloseTo(1 / 1001, 12);
    expect(largeLow).toBeCloseTo(1 / 1002, 12);

    const smallRatio = smallTop / smallLow;
    const largeRatio = largeTop / largeLow;
    expect(smallRatio).toBeGreaterThan(largeRatio);
  });

  it("returns an empty array for empty input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe("dedupeByChunkId", () => {
  it("keeps the first occurrence of each chunkId, preserving order", () => {
    const hits = [
      makeHit("a", 0.9, "first a"),
      makeHit("b", 0.8, "first b"),
      makeHit("a", 0.1, "second a"),
      makeHit("c", 0.7, "first c"),
      makeHit("b", 0.2, "second b")
    ];

    const out = dedupeByChunkId(hits);

    expect(out.map((h) => h.chunkId)).toEqual(["a", "b", "c"]);
    expect(out.find((h) => h.chunkId === "a")!.content).toBe("first a");
    expect(out.find((h) => h.chunkId === "b")!.content).toBe("first b");
  });

  it("returns an empty array unchanged", () => {
    expect(dedupeByChunkId([])).toEqual([]);
  });
});
