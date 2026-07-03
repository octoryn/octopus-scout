import { sha256 } from "../utils/hash.js";
import { loadConfig } from "../config.js";
import type { EmbeddingProvider } from "../types.js";

const LEXICAL_DIMENSIONS = 256;

/**
 * Tokenize for the lexical embedder: lowercase, split on non-alphanumeric runs,
 * drop empties, and apply a tiny, deterministic suffix stemmer so that simple
 * inflections ("chloroplasts" / "chloroplast", "runs" / "run") collide into the
 * same bucket. This is intentionally crude — no dictionary, no dependency — but
 * it meaningfully improves keyword-overlap recall for English text.
 */
function lexicalTokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length === 0) continue;
    tokens.push(stem(raw));
  }
  return tokens;
}

/** Strip a few common English suffixes; leaves the token as-is when too short. */
function stem(token: string): string {
  if (token.length <= 3) return token;
  for (const suffix of ["ingly", "edly", "ing", "ies", "ied", "ed", "ly", "es", "s"]) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

/**
 * Hash a token to a stable bucket index in [0, dimensions) and a sign in
 * {-1, +1}. Signed hashing (the "hashing trick") keeps collisions from
 * systematically inflating similarity: two unrelated tokens landing in the same
 * bucket cancel out roughly half the time instead of always adding.
 */
function hashToken(token: string, dimensions: number): { bucket: number; sign: number } {
  const digest = sha256(token);
  // First 8 hex chars -> bucket; next hex char parity -> sign. sha256 output is
  // deterministic, so the same token always maps to the same (bucket, sign).
  const bucket = parseInt(digest.slice(0, 8), 16) % dimensions;
  const sign = parseInt(digest.slice(8, 9), 16) % 2 === 0 ? 1 : -1;
  return { bucket, sign };
}

/**
 * Default embedding provider: a DETERMINISTIC, ZERO-DEPENDENCY, OFFLINE lexical
 * (feature-hashing) embedder. It is NOT semantic — it does not understand
 * meaning, synonyms, or paraphrase — but it IS real keyword-overlap retrieval
 * (a BM25-lite hashing vectorizer), so vector/hybrid search returns genuinely
 * useful results on a fresh clone with no API key and no configuration.
 *
 * How it works: tokenize (lowercase, split on non-alphanumerics, light suffix
 * stemming), hash each token into one of {@link LEXICAL_DIMENSIONS} buckets with
 * a signed-hashing trick, accumulate a sub-linear term-frequency weight
 * (`1 + log(tf)`) per bucket, then L2-normalize. Because vectors are unit-length,
 * cosine similarity ranks documents by weighted shared-keyword overlap.
 *
 * For TRUE semantic search (synonyms, paraphrase, cross-lingual), configure a
 * real provider: Voyage/OpenAI implement {@link EmbeddingProvider} and are
 * swapped in via {@link getEmbeddingProvider} by setting
 * `OCTORYN_SCOUT_EMBEDDING_PROVIDER` + the matching API key.
 */
export class LexicalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "lexical-hash-256";
  readonly dimensions = LEXICAL_DIMENSIONS;

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedOne(text)));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);

    // Term frequencies over stemmed tokens.
    const tf = new Map<string, number>();
    for (const token of lexicalTokenize(text)) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // Accumulate a sub-linear tf weight into each token's signed bucket.
    for (const [token, count] of tf) {
      const weight = 1 + Math.log(count);
      const { bucket, sign } = hashToken(token, this.dimensions);
      vec[bucket] += sign * weight;
    }

    // L2-normalize so cosine similarity ranks by weighted keyword overlap.
    // An empty/tokenless input yields the zero vector (norm 0) unchanged, which
    // cosineSimilarity() safely scores as 0 against everything.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}

/**
 * @deprecated Historical name for the default offline embedder. Retained as an
 * alias so existing imports keep working; use {@link LexicalEmbeddingProvider}.
 * The old implementation was a non-semantic hash-of-the-whole-string stub that
 * made vector search meaningless; this now IS keyword-overlap retrieval.
 */
export const StubEmbeddingProvider = LexicalEmbeddingProvider;

interface OpenAIStyleEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

/**
 * Shared POST + parse logic for OpenAI-compatible embedding endpoints (both
 * Voyage and OpenAI use the `{ data: [{ index, embedding }] }` response shape).
 * Returns embeddings ordered by `.index`. Throws a descriptive Error on any
 * non-2xx response (status + body) so callers can surface the failure.
 */
async function postEmbeddings(endpoint: string, apiKey: string, model: string, texts: string[]): Promise<number[][]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ input: texts, model })
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "<unreadable response body>";
    }
    throw new Error(
      `Embedding request to ${endpoint} failed: HTTP ${response.status} ${response.statusText} - ${body}`
    );
  }

  const json = (await response.json()) as OpenAIStyleEmbeddingResponse;
  const data = json.data ?? [];
  const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return sorted.map((entry) => entry.embedding ?? []);
}

/**
 * Real embedding provider backed by Voyage AI's embeddings API. The vector
 * dimensionality is discovered from the first returned vector after the first
 * successful call.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly model: string;
  dimensions = 1024;

  private readonly apiKey: string;
  private static readonly ENDPOINT = "https://api.voyageai.com/v1/embeddings";

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "voyage-3";
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors = await postEmbeddings(VoyageEmbeddingProvider.ENDPOINT, this.apiKey, this.model, texts);
    if (vectors.length > 0 && vectors[0].length > 0) {
      this.dimensions = vectors[0].length;
    }
    return vectors;
  }
}

/**
 * Real embedding provider backed by OpenAI's embeddings API.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  dimensions = 1536;

  private readonly apiKey: string;
  private static readonly ENDPOINT = "https://api.openai.com/v1/embeddings";

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "text-embedding-3-small";
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors = await postEmbeddings(OpenAIEmbeddingProvider.ENDPOINT, this.apiKey, this.model, texts);
    if (vectors.length > 0 && vectors[0].length > 0) {
      this.dimensions = vectors[0].length;
    }
    return vectors;
  }
}

let provider: EmbeddingProvider | undefined;

// Module-level guard so the missing-key warning is logged at most once per
// process, rather than on every call.
let warnedMissingKey = false;

/** Name of the built-in offline lexical (keyword-overlap) embedder. */
export const LEXICAL_PROVIDER_NAME = "lexical-hash-256";

/**
 * Returns the active embedding provider, selected from config:
 *  - "voyage" + a Voyage API key   -> {@link VoyageEmbeddingProvider}
 *  - "openai" + an OpenAI API key   -> {@link OpenAIEmbeddingProvider}
 *  - "lexical"/"stub" or missing key -> {@link LexicalEmbeddingProvider}
 *
 * Never throws on a missing key: a misconfigured real provider degrades
 * gracefully to the built-in offline lexical embedder. That fallback is a
 * genuine keyword-overlap retriever (not a meaningless stub), so search still
 * works — but it is NOT semantic, so we emit a one-time console.warn whenever a
 * real (semantic) provider was requested without a key.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!provider) {
    const config = loadConfig();
    if (config.embeddingProvider === "voyage" && config.voyageApiKey) {
      provider = new VoyageEmbeddingProvider(config.voyageApiKey, config.embeddingModel);
    } else if (config.embeddingProvider === "openai" && config.openaiApiKey) {
      provider = new OpenAIEmbeddingProvider(config.openaiApiKey, config.embeddingModel);
    } else {
      if ((config.embeddingProvider === "openai" || config.embeddingProvider === "voyage") && !warnedMissingKey) {
        warnedMissingKey = true;
        console.warn(
          `[octopus-scout] OCTORYN_SCOUT_EMBEDDING_PROVIDER=${config.embeddingProvider} but no API key set — falling back to the offline lexical embedder (deterministic keyword-overlap retrieval, not semantic). Set the matching API key for true semantic search.`
        );
      }
      provider = new LexicalEmbeddingProvider();
    }
  }
  return provider;
}

/**
 * Describes the currently active embedding provider for readiness reporting.
 * `semantic` is true only for a real provider (Voyage/OpenAI); the built-in
 * lexical embedder is honest keyword-overlap retrieval, not semantic search.
 */
export function activeEmbeddingInfo(): { provider: string; semantic: boolean } {
  const active = getEmbeddingProvider();
  return { provider: active.name, semantic: active.name !== LEXICAL_PROVIDER_NAME };
}
