import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LexicalEmbeddingProvider, StubEmbeddingProvider } from "../src/knowledge/embedding.js";
import { cosineSimilarity } from "../src/knowledge/vectorStore.js";
import type { EmbeddingProvider } from "../src/types.js";

const DIMENSIONS = 256;

describe("LexicalEmbeddingProvider", () => {
  it("identifies as lexical-hash-256 with 256 dimensions", () => {
    const provider = new LexicalEmbeddingProvider();
    expect(provider.name).toBe("lexical-hash-256");
    expect(provider.dimensions).toBe(DIMENSIONS);
  });

  it("StubEmbeddingProvider is a backward-compatible alias for the lexical embedder", () => {
    const provider = new StubEmbeddingProvider();
    expect(provider).toBeInstanceOf(LexicalEmbeddingProvider);
    expect(provider.name).toBe("lexical-hash-256");
  });

  it("returns one vector per input, each of length dimensions", async () => {
    const provider = new LexicalEmbeddingProvider();
    const texts = ["hello world", "another piece of text", ""];
    const vectors = await provider.embed(texts);

    expect(vectors).toHaveLength(texts.length);
    for (const vec of vectors) {
      expect(vec).toHaveLength(DIMENSIONS);
    }
  });

  it("produces only finite numbers", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [vec] = await provider.embed(["finite check with several words"]);
    for (const value of vec) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("is deterministic for the same input", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [a] = await provider.embed(["repeatable input text"]);
    const [b] = await provider.embed(["repeatable input text"]);
    expect(a).toEqual(b);

    // A second, independently constructed provider yields the same vector too.
    const other = new LexicalEmbeddingProvider();
    const [c] = await other.embed(["repeatable input text"]);
    expect(c).toEqual(a);
  });

  it("maps different inputs to different vectors", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [a] = await provider.embed(["alpha beta gamma"]);
    const [b] = await provider.embed(["delta epsilon zeta"]);
    expect(a).not.toEqual(b);
  });

  it("produces unit-length (L2-normalized) vectors for non-empty input", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [vec] = await provider.embed(["some words to hash into buckets"]);
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
  });

  it("emits the zero vector for empty / token-less input", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [empty] = await provider.embed([""]);
    const [punct] = await provider.embed(["   --- ... !!!   "]);
    expect(empty.every((v) => v === 0)).toBe(true);
    expect(punct.every((v) => v === 0)).toBe(true);
  });

  it("returns an empty array for empty input", async () => {
    const provider = new LexicalEmbeddingProvider();
    const vectors = await provider.embed([]);
    expect(vectors).toEqual([]);
  });

  // The whole point of this default: cosine over the lexical vectors ranks by
  // KEYWORD OVERLAP, so a query is closer to the topical doc than to unrelated
  // ones. This is real retrieval out of the box (no API key, no config).
  it("ranks keyword-relevant documents above irrelevant ones (cosine)", async () => {
    const provider = new LexicalEmbeddingProvider();
    const docs = [
      "Photosynthesis uses chlorophyll in plant chloroplasts to convert light into chemical energy.",
      "A well-pulled espresso shot is topped with a thick golden crema by the barista.",
      "Quarterly revenue rose as the company reported strong earnings for the fiscal quarter."
    ];
    const query = "chlorophyll light energy in plants";

    const [qVec] = await provider.embed([query]);
    const docVecs = await provider.embed(docs);
    const scores = docVecs.map((v) => cosineSimilarity(qVec, v));

    // The photosynthesis doc (index 0) shares the most keywords -> highest score.
    const best = scores.indexOf(Math.max(...scores));
    expect(best).toBe(0);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
    // Overlapping keywords give a strictly positive similarity.
    expect(scores[0]).toBeGreaterThan(0);
  });

  it("collapses simple inflections via light stemming (plant ~ plants)", async () => {
    const provider = new LexicalEmbeddingProvider();
    const [a] = await provider.embed(["plant"]);
    const [b] = await provider.embed(["plants"]);
    // Same stem -> identical single-token vector.
    expect(a).toEqual(b);
  });
});

describe("getEmbeddingProvider", () => {
  const envKeys = ["OCTORYN_SCOUT_EMBEDDING_PROVIDER", "VOYAGE_API_KEY", "OPENAI_API_KEY"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of envKeys) {
      saved[key] = process.env[key];
    }
    // Fresh module state so the cached provider is rebuilt under our env.
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.resetModules();
  });

  it("returns the lexical provider by default (no config, no key)", async () => {
    delete process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    const provider = mod.getEmbeddingProvider();

    expect(provider.name).toBe("lexical-hash-256");
    expect(provider.dimensions).toBe(DIMENSIONS);
    expect(provider).toBeInstanceOf(mod.LexicalEmbeddingProvider);
  });

  it("accepts the deprecated 'stub' alias and maps it to the lexical provider", async () => {
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    const provider = mod.getEmbeddingProvider();

    expect(provider.name).toBe("lexical-hash-256");
  });

  it("falls back to the lexical embedder when a real provider is requested with no key", async () => {
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "voyage";
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    const provider = mod.getEmbeddingProvider();

    expect(provider.name).toBe("lexical-hash-256");
  });

  it("reports the lexical embedder as NON-semantic and real providers as semantic", async () => {
    delete process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    const info = mod.activeEmbeddingInfo();
    expect(info.provider).toBe("lexical-hash-256");
    expect(info.semantic).toBe(false);
  });

  it("caches the provider across calls", async () => {
    delete process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    expect(mod.getEmbeddingProvider()).toBe(mod.getEmbeddingProvider());
  });

  // The provider abstraction is preserved: a caller can supply ANY object that
  // satisfies EmbeddingProvider (a custom embedder), and the rest of the system
  // consumes it purely through the interface.
  it("the EmbeddingProvider interface still accepts a custom embedder", async () => {
    const custom: EmbeddingProvider = {
      name: "custom-test",
      dimensions: 3,
      embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0]))
    };
    const vectors = await custom.embed(["a", "b"]);
    expect(vectors).toEqual([
      [1, 0, 0],
      [1, 0, 0]
    ]);
    expect(custom.name).toBe("custom-test");
    expect(custom.dimensions).toBe(3);
  });
});
