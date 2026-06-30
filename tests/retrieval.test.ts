import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Hermetic, end-to-end retrieval test for the RAG write-path (ingestUrl) and
 * read-path (searchKnowledge).
 *
 * Everything runs offline: a tiny node:http server on 127.0.0.1 serves a page
 * with distinctive text, the deterministic stub embedding provider is forced
 * (no provider keys), and the file-backed vector store is rooted in a unique
 * OS temp dir (no DATABASE_URL). The retrieval module reads its config + picks
 * its singletons lazily off process.env, so we set env BEFORE importing it via
 * dynamic import.
 */

// A unique, distinctive marker so the served page's text is unmistakable in
// search hits and cannot collide with anything else on disk.
const MARKER = `quokka-${randomUUID().slice(0, 8)}`;
const DISTINCTIVE_QUERY = `${MARKER} photosynthesis archipelago`;

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Retrieval Fixture ${MARKER}</title>
    <meta name="description" content="A hermetic retrieval test fixture" />
  </head>
  <body>
    <article>
      <h1>Retrieval Fixture ${MARKER}</h1>
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

describe("retrieval: hermetic ingest + search (stub embeddings, file store)", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;
  let pagePath: string | undefined; // the exact normalized source URL of the page
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
      "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
      "OCTORYN_SCOUT_APPROVAL_MODE"
    );

    // Force file-backed store + deterministic stub embeddings.
    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-retrieval-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    // The SSRF guard blocks private/loopback IPs by default; this fixture is
    // served on 127.0.0.1, so opt into private hosts before importing the
    // retrieval module (which reads config lazily off process.env). Restored
    // in afterEach via restoreEnv(); the guard's production default is unchanged.
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";

    // Serve the fixture (and an empty robots.txt) on localhost.
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
      // normalizeUrl turns http://127.0.0.1:PORT/page into a trailing-path URL;
      // the page path keeps an explicit pathname so sourceUrl is unambiguous.
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

  it("ingests a served page then finds it via semantic search", async (ctx) => {
    if (!canBind) {
      // Could not bind a localhost socket in this sandbox; skip gracefully
      // (equivalent to it.skip — no network or server means nothing to assert).
      ctx.skip();
      return;
    }

    // Import AFTER env is set so config-driven singletons pick up the temp dir
    // + stub provider.
    const { ingestUrl, searchKnowledge } = await import("../src/knowledge/retrieval.js");

    const ingest = await ingestUrl({ url: pagePath! });

    expect(ingest.governanceStatus).not.toBe("blocked");
    expect(ingest.skipped).not.toBe(true);
    expect(ingest.chunksIndexed).toBeGreaterThan(0);
    expect(ingest.sourceUrl).toContain("127.0.0.1");

    const search = await searchKnowledge({ query: DISTINCTIVE_QUERY, topK: 3 });

    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits.length).toBeLessThanOrEqual(3);

    const top = search.hits[0];
    expect(top.sourceUrl).toBe(ingest.sourceUrl);
    // The stub embedder is hash-based, not semantic, so the cosine score sign is
    // arbitrary — only assert it is a finite number. Real providers yield ranked
    // scores; semantic ordering is not testable with the deterministic stub.
    expect(Number.isFinite(top.score)).toBe(true);
  });

  it("enforce mode QUARANTINES requires_approval content (not indexed); flag mode indexes but hides it until approved", async (ctx) => {
    if (!canBind) {
      ctx.skip();
      return;
    }

    // A domain policy that requires approval for 127.0.0.1 escalates the
    // decision to "requires_approval" without changing the served body.
    await writeFile(
      join(dataDir, "policy.json"),
      JSON.stringify({ version: "test-approval", domains: [{ domain: "127.0.0.1", action: "require_approval" }] })
    );

    // --- enforce: quarantine (never indexed) ---------------------------------
    process.env.OCTORYN_SCOUT_APPROVAL_MODE = "enforce";
    {
      const { ingestUrl, searchKnowledge } = await import("../src/knowledge/retrieval.js");
      const ingest = await ingestUrl({ url: pagePath! });
      expect(ingest.governanceStatus).toBe("requires_approval");
      expect(ingest.skipped).toBe(true);
      expect(ingest.reason).toBe("requires approval (enforce mode)");
      expect(ingest.chunksIndexed).toBe(0);

      // Nothing indexed -> not searchable even with includeUnapproved.
      const search = await searchKnowledge({ query: DISTINCTIVE_QUERY, topK: 3, includeUnapproved: true });
      expect(search.hits).toEqual([]);
    }

    // --- flag: indexed, but filtered from default search until approved ------
    const { resetPolicyCache } = await import("../src/governance/policy.js");
    resetPolicyCache();
    process.env.OCTORYN_SCOUT_APPROVAL_MODE = "flag";
    {
      const { ingestUrl, searchKnowledge } = await import("../src/knowledge/retrieval.js");
      const ingest = await ingestUrl({ url: pagePath!, forceRefresh: true });
      expect(ingest.governanceStatus).toBe("requires_approval");
      expect(ingest.skipped).toBe(false);
      expect(ingest.chunksIndexed).toBeGreaterThan(0);

      // Default search excludes requires_approval...
      const hidden = await searchKnowledge({ query: DISTINCTIVE_QUERY, topK: 3 });
      expect(hidden.hits).toEqual([]);

      // ...but includeUnapproved surfaces it.
      const shown = await searchKnowledge({ query: DISTINCTIVE_QUERY, topK: 3, includeUnapproved: true });
      expect(shown.hits.length).toBeGreaterThan(0);
    }
  });
});
