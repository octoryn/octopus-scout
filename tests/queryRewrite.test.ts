import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rewriteQuery } from "../src/knowledge/retrieval.js";

/**
 * Tests for heuristic query rewriting (rewriteQuery) and rewrite-enabled
 * searchKnowledge fusion.
 *
 * rewriteQuery is pure and dependency-free, so it is tested directly. The
 * rewrite:true search reuses the same hermetic fixture pattern as
 * retrieval.test.ts: a localhost node:http server, the default offline lexical
 * embedding provider, and a file-backed vector store in a temp dir. The lexical
 * embedder is keyword-overlap-based (not semantic), so we exercise lexical mode
 * for the "clearly-matching keyword" assertion and never assert cosine sign.
 */

describe("rewriteQuery: heuristic, deterministic variants", () => {
  it("returns the original plus a normalized variant for a punctuated, mixed-case query and dedups", () => {
    const variants = rewriteQuery("What IS Photosynthesis?!");

    // Original is preserved verbatim (trimmed).
    expect(variants[0]).toBe("What IS Photosynthesis?!");
    // A normalized variant (lowercased, punctuation stripped, collapsed) is present.
    expect(variants).toContain("what is photosynthesis");
    // Keyword-only expansion drops stopwords ("what", "is").
    expect(variants).toContain("photosynthesis");
    // All variants are unique.
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("collapses an already-normalized, stopword-free query to a single variant", () => {
    const variants = rewriteQuery("photosynthesis archipelago");
    expect(variants).toEqual(["photosynthesis archipelago"]);
  });

  it("returns an empty array for an empty/whitespace query", () => {
    expect(rewriteQuery("")).toEqual([]);
    expect(rewriteQuery("   ")).toEqual([]);
  });

  it("dedups when normalization equals the original", () => {
    const variants = rewriteQuery("quokka habitat ecology");
    // original === normalized; keyword variant identical (no stopwords) -> one entry.
    expect(variants).toEqual(["quokka habitat ecology"]);
  });
});

const MARKER = `quokka-${randomUUID().slice(0, 8)}`;

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Rewrite Fixture ${MARKER}</title>
    <meta name="description" content="A hermetic query-rewrite test fixture" />
  </head>
  <body>
    <article>
      <h1>Rewrite Fixture ${MARKER}</h1>
      <p>
        This fixture page describes the ${MARKER} marsupial and its unusual
        relationship with photosynthesis across a remote archipelago. The text
        is intentionally long enough for Readability to extract a meaningful
        article body and for the chunker to produce at least one chunk.
      </p>
      <p>
        Researchers studying the ${MARKER} archipelago documented how
        photosynthesis-adjacent symbiosis shaped the local ecology over many
        seasons, providing a stable and distinctive corpus of prose to index.
      </p>
      <p>
        Additional paragraphs ensure there is ample body content so the
        extraction and chunking pipeline behaves exactly as it would for a real
        web article about the ${MARKER} subject and its archipelago habitat.
      </p>
    </article>
  </body>
</html>`;
}

describe("searchKnowledge rewrite: fused, finite, governance-respecting hits", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;
  let pagePath: string | undefined;
  let dataDir: string;
  let canBind = true;

  const prev: Record<string, string | undefined> = {};
  function snapshotEnv(...keys: string[]): void {
    for (const k of keys) prev[k] = process.env[k];
  }
  function restoreEnv(): void {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(async () => {
    snapshotEnv(
      "OCTORYN_SCOUT_DATA_DIR",
      "DATABASE_URL",
      "OCTORYN_SCOUT_EMBEDDING_PROVIDER",
      "VOYAGE_API_KEY",
      "OPENAI_API_KEY",
      "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS"
    );

    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-rewrite-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";

    const body = pageHtml();
    server = createServer((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      pagePath = `${baseUrl}/page`;
    } catch {
      canBind = false;
    }
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    restoreEnv();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("rewrite:true returns finite, governance-respecting hits for a matching keyword (lexical mode)", async (ctx) => {
    if (!canBind) {
      ctx.skip();
      return;
    }

    const { ingestUrl, searchKnowledge } = await import("../src/knowledge/retrieval.js");

    const ingest = await ingestUrl({ url: pagePath! });
    expect(ingest.skipped).not.toBe(true);
    expect(ingest.chunksIndexed).toBeGreaterThan(0);

    // A punctuated, mixed-case query so rewriteQuery yields >1 variant and the
    // fusion path is actually exercised. Lexical mode so the hash-based stub
    // embedder is not relied upon for relevance.
    const search = await searchKnowledge({
      query: `What IS the ${MARKER} archipelago?`,
      topK: 3,
      mode: "lexical",
      rewrite: true
    });

    expect(search.hits.length).toBeGreaterThanOrEqual(1);
    expect(search.hits.length).toBeLessThanOrEqual(3);

    for (const hit of search.hits) {
      expect(Number.isFinite(hit.score)).toBe(true);
      // Governance respected: default search never surfaces non-allowed content.
      expect(hit.governanceStatus).toBe("allowed");
      expect(hit.sourceUrl).toBe(ingest.sourceUrl);
    }
  });
});
