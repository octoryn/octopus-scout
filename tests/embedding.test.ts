import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StubEmbeddingProvider } from "../src/knowledge/embedding.js";

const DIMENSIONS = 256;

describe("StubEmbeddingProvider", () => {
  it("identifies as stub-hash-256 with 256 dimensions", () => {
    const provider = new StubEmbeddingProvider();
    expect(provider.name).toBe("stub-hash-256");
    expect(provider.dimensions).toBe(DIMENSIONS);
  });

  it("returns one vector per input, each of length dimensions", async () => {
    const provider = new StubEmbeddingProvider();
    const texts = ["hello world", "another piece of text", ""];
    const vectors = await provider.embed(texts);

    expect(vectors).toHaveLength(texts.length);
    for (const vec of vectors) {
      expect(vec).toHaveLength(DIMENSIONS);
    }
  });

  it("produces only finite numbers", async () => {
    const provider = new StubEmbeddingProvider();
    const [vec] = await provider.embed(["finite check"]);
    for (const value of vec) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("is deterministic for the same input", async () => {
    const provider = new StubEmbeddingProvider();
    const [a] = await provider.embed(["repeatable input"]);
    const [b] = await provider.embed(["repeatable input"]);
    expect(a).toEqual(b);

    // A second, independently constructed provider yields the same vector too.
    const other = new StubEmbeddingProvider();
    const [c] = await other.embed(["repeatable input"]);
    expect(c).toEqual(a);
  });

  it("maps different inputs to different vectors", async () => {
    const provider = new StubEmbeddingProvider();
    const [a] = await provider.embed(["alpha"]);
    const [b] = await provider.embed(["beta"]);
    expect(a).not.toEqual(b);
  });

  it("returns an empty array for empty input", async () => {
    const provider = new StubEmbeddingProvider();
    const vectors = await provider.embed([]);
    expect(vectors).toEqual([]);
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

  it("returns the stub provider when configured for stub", async () => {
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    const provider = mod.getEmbeddingProvider();

    expect(provider.name).toBe("stub-hash-256");
    expect(provider.dimensions).toBe(DIMENSIONS);
    expect(provider).toBeInstanceOf(mod.StubEmbeddingProvider);
  });

  it("falls back to the stub when no API keys are present", async () => {
    // Even if a real provider is requested, a missing key degrades to the stub.
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "voyage";
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    const provider = mod.getEmbeddingProvider();

    expect(provider.name).toBe("stub-hash-256");
  });

  it("caches the provider across calls", async () => {
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const mod = await import("../src/knowledge/embedding.js");
    expect(mod.getEmbeddingProvider()).toBe(mod.getEmbeddingProvider());
  });
});
