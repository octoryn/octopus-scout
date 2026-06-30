import { describe, expect, it } from "vitest";
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from "../src/knowledge/embedding.js";

/**
 * Live, key-gated contract tests for the real embedding providers.
 *
 * These hit the actual third-party APIs, so they only run when the relevant
 * API key is present in the environment; otherwise they SKIP (CI-safe, no key
 * required). No key is ever stored in this file.
 *
 *   OPENAI_API_KEY=sk-... npx vitest run tests/embeddingLive.test.ts
 *   VOYAGE_API_KEY=pa-...  npx vitest run tests/embeddingLive.test.ts
 */

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const RELATED_A = "The cat sat on the warm windowsill in the afternoon sun.";
const RELATED_B = "A feline rested by the sunny window during the day.";
const UNRELATED = "Quarterly revenue grew on strong cloud infrastructure sales.";

describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAIEmbeddingProvider (live)", () => {
  const provider = new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY ?? "");

  it("returns one finite vector per input and infers dimensions", { timeout: 30_000 }, async () => {
    const vectors = await provider.embed([RELATED_A, RELATED_B, UNRELATED]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v.length).toBeGreaterThan(0);
      expect(v.length).toBe(provider.dimensions);
      expect(v.every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  it("produces semantically meaningful similarity (related > unrelated)", { timeout: 30_000 }, async () => {
    const [a, b, c] = await provider.embed([RELATED_A, RELATED_B, UNRELATED]);
    const related = cosine(a, b);
    const unrelated = cosine(a, c);
    expect(related).toBeGreaterThan(unrelated);
    expect(related).toBeGreaterThan(0.5);
  });
});

describe.skipIf(!process.env.VOYAGE_API_KEY)("VoyageEmbeddingProvider (live)", () => {
  const provider = new VoyageEmbeddingProvider(process.env.VOYAGE_API_KEY ?? "");

  it("returns finite vectors and related > unrelated similarity", { timeout: 30_000 }, async () => {
    const [a, b, c] = await provider.embed([RELATED_A, RELATED_B, UNRELATED]);
    expect(a.length).toBe(provider.dimensions);
    expect(a.every((x) => Number.isFinite(x))).toBe(true);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});
