import { sha256 } from "../utils/hash.js";
import { loadConfig } from "../config.js";
import type { EmbeddingProvider } from "../types.js";

const STUB_DIMENSIONS = 256;

/**
 * Deterministic, network-free embedding provider. Produces a normalized vector
 * derived purely from a hash of each input text, so the same text always maps
 * to the same vector. This is the documented hook point: real providers
 * (Voyage, OpenAI, etc.) implement {@link EmbeddingProvider} and are swapped in
 * via {@link getEmbeddingProvider}.
 */
export class StubEmbeddingProvider implements EmbeddingProvider {
  readonly name = "stub-hash-256";
  readonly dimensions = STUB_DIMENSIONS;

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedOne(text)));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    // Expand the 32-byte sha256 digest into `dimensions` deterministic floats by
    // re-hashing with a counter until we have enough bytes.
    let filled = 0;
    let counter = 0;
    while (filled < this.dimensions) {
      const digest = sha256(`${text}#${counter}`);
      for (let i = 0; i + 1 < digest.length && filled < this.dimensions; i += 2) {
        const byte = parseInt(digest.slice(i, i + 2), 16);
        // Map [0,255] -> [-1, 1].
        vec[filled] = byte / 127.5 - 1;
        filled += 1;
      }
      counter += 1;
    }
    // L2-normalize so vectors are cosine-comparable.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}

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

// Module-level guards so each misconfiguration/usability warning is logged at
// most once per process, rather than on every call.
let warnedMissingKey = false;
let warnedStub = false;

const STUB_PROVIDER_NAME = "stub-hash-256";

/**
 * Returns the active embedding provider, selected from config:
 *  - "voyage" + a Voyage API key  -> {@link VoyageEmbeddingProvider}
 *  - "openai" + an OpenAI API key  -> {@link OpenAIEmbeddingProvider}
 *  - otherwise (incl. missing key) -> {@link StubEmbeddingProvider}
 *
 * Never throws on a missing key: a misconfigured real provider degrades
 * gracefully to the network-free stub. Because that fallback silently turns
 * vector search into meaningless hash-distance noise, we emit a one-time
 * console.warn whenever a real provider is requested without a key, and a
 * one-time console.warn whenever the active provider resolves to the stub.
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
          `[octopus-scout] OCTORYN_SCOUT_EMBEDDING_PROVIDER=${config.embeddingProvider} but no API key set — falling back to the non-semantic stub embedder; vector search will be meaningless.`
        );
      }
      provider = new StubEmbeddingProvider();
    }

    if (provider.name === STUB_PROVIDER_NAME && !warnedStub) {
      warnedStub = true;
      console.warn(
        "[octopus-scout] using stub embeddings (non-semantic, deterministic hashes). Set OCTORYN_SCOUT_EMBEDDING_PROVIDER + key for real semantic search."
      );
    }
  }
  return provider;
}

/**
 * Describes the currently active embedding provider for readiness reporting.
 * `semantic` is false only when the active provider is the deterministic hash
 * stub (which makes vector search meaningless), true for any real provider.
 */
export function activeEmbeddingInfo(): { provider: string; semantic: boolean } {
  const active = getEmbeddingProvider();
  return { provider: active.name, semantic: active.name !== STUB_PROVIDER_NAME };
}
