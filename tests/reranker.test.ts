import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VectorSearchHit } from "../src/types.js";

// Build a VectorSearchHit with sensible defaults so each test only specifies the
// fields it cares about (content, headingPath, score, trustScore, ids).
function makeHit(overrides: Partial<VectorSearchHit> & { chunkId: string }): VectorSearchHit {
  return {
    documentId: "doc-1",
    score: 0.5,
    sourceUrl: "https://example.com/page",
    finalUrl: "https://example.com/page",
    title: "Example",
    content: "",
    headingPath: [],
    contentHash: "hash",
    governanceStatus: "allowed",
    trustScore: 0.5,
    ...overrides
  };
}

const RERANK_ENV_KEYS = ["OCTORYN_SCOUT_RERANK_PROVIDER", "COHERE_API_KEY", "VOYAGE_API_KEY"] as const;

describe("HeuristicReranker.rerank", () => {
  it("ranks the term-matching hit first over a non-matching hit", async () => {
    const { HeuristicReranker } = await import("../src/knowledge/reranker.js");
    const reranker = new HeuristicReranker();

    const query = "octopus camouflage skin";
    // Equal incoming scores so the lexical-overlap component is the deciding
    // factor: this isolates the term-matching behavior under test from the
    // min-max-normalized incoming-score component of the blend.
    const hits: VectorSearchHit[] = [
      // No query terms present.
      makeHit({
        chunkId: "none",
        content: "Completely unrelated text about weather and rainfall patterns.",
        headingPath: ["Weather"],
        score: 0.5
      }),
      // Contains all query terms.
      makeHit({
        chunkId: "all",
        content: "The octopus uses camouflage to change its skin color instantly.",
        headingPath: ["Biology"],
        score: 0.5
      }),
      // Partial match.
      makeHit({
        chunkId: "partial",
        content: "An octopus is a cephalopod with eight arms.",
        headingPath: ["Anatomy"],
        score: 0.5
      })
    ];

    const out = await reranker.rerank(query, hits, 3);

    expect(out[0].chunkId).toBe("all");
  });

  it("truncates output to topK", async () => {
    const { HeuristicReranker } = await import("../src/knowledge/reranker.js");
    const reranker = new HeuristicReranker();

    const hits: VectorSearchHit[] = [
      makeHit({ chunkId: "a", content: "alpha term", score: 0.3 }),
      makeHit({ chunkId: "b", content: "beta term", score: 0.6 }),
      makeHit({ chunkId: "c", content: "gamma term", score: 0.9 })
    ];

    const out = await reranker.rerank("term", hits, 2);

    expect(out.length).toBeLessThanOrEqual(2);
    expect(out.length).toBe(2);
  });

  it("is deterministic across repeated runs", async () => {
    const { HeuristicReranker } = await import("../src/knowledge/reranker.js");
    const reranker = new HeuristicReranker();

    const query = "octopus camouflage skin";
    const hits: VectorSearchHit[] = [
      makeHit({ chunkId: "none", content: "weather and rainfall", score: 0.9 }),
      makeHit({
        chunkId: "all",
        content: "octopus camouflage skin color",
        headingPath: ["Biology"],
        score: 0.1
      }),
      makeHit({ chunkId: "partial", content: "octopus arms", score: 0.5 })
    ];

    const first = await reranker.rerank(query, hits, 3);
    const second = await reranker.rerank(query, hits, 3);

    expect(first.map((h) => h.chunkId)).toEqual(second.map((h) => h.chunkId));
    expect(first.map((h) => h.score)).toEqual(second.map((h) => h.score));
  });

  it("sets a numeric score on each returned hit", async () => {
    const { HeuristicReranker } = await import("../src/knowledge/reranker.js");
    const reranker = new HeuristicReranker();

    const hits: VectorSearchHit[] = [
      makeHit({ chunkId: "a", content: "octopus camouflage skin", score: 0.2 }),
      makeHit({ chunkId: "b", content: "weather", score: 0.8 })
    ];

    const out = await reranker.rerank("octopus camouflage skin", hits, 2);

    expect(out.length).toBeGreaterThan(0);
    for (const hit of out) {
      expect(typeof hit.score).toBe("number");
      expect(Number.isFinite(hit.score)).toBe(true);
    }
  });
});

describe("getReranker", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of RERANK_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of RERANK_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.resetModules();
  });

  it("returns a HeuristicReranker (name 'heuristic') when provider unset and no keys", async () => {
    const { getReranker } = await import("../src/knowledge/reranker.js");
    const reranker = getReranker();
    expect(reranker.name).toBe("heuristic");
  });

  it("returns a NoopReranker (name 'none') when provider set to 'none'", async () => {
    process.env.OCTORYN_SCOUT_RERANK_PROVIDER = "none";
    const { getReranker } = await import("../src/knowledge/reranker.js");
    const reranker = getReranker();
    expect(reranker.name).toBe("none");
  });
});
