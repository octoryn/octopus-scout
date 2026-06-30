import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Hermetic, end-to-end whole-site ingestion test for ingestSite().
 *
 * Everything runs offline: a tiny node:http server on 127.0.0.1 serves three
 * interlinked HTML pages (each with an empty /robots.txt), the deterministic
 * stub embedding provider is forced (no provider keys), and the file-backed
 * vector store is rooted in a unique OS temp dir (no DATABASE_URL). The
 * siteIngest module (and its transitive singletons) read config lazily off
 * process.env, so env is set BEFORE importing it via dynamic import.
 *
 * We crawl the site (maxDepth 1, maxPages 3), assert the SiteIngestResult is
 * well-formed (pages crawled/indexed, chunks indexed, per-page entries), then
 * confirm a distinctive marker from the served prose is retrievable via
 * searchKnowledge.
 */

// A unique, distinctive marker so the served pages' text is unmistakable in
// search hits and cannot collide with anything else on disk.
const MARKER = `quokka-${randomUUID().slice(0, 8)}`;
const DISTINCTIVE_QUERY = `${MARKER} photosynthesis archipelago`;

function bodyParagraphs(topic: string): string {
  return `
      <p>
        This fixture page describes the ${MARKER} ${topic} and its unusual
        relationship with photosynthesis across a remote archipelago. The text
        is intentionally long enough for Readability to extract a meaningful
        article body and for the chunker to produce at least one chunk.
      </p>
      <p>
        Researchers studying the ${MARKER} archipelago documented how
        photosynthesis-adjacent symbiosis shaped the local ecology over many
        seasons, providing a stable and distinctive corpus of prose to index
        and retrieve deterministically in a hermetic test environment.
      </p>
      <p>
        Additional paragraphs ensure there is ample body content so the
        extraction and chunking pipeline behaves exactly as it would for a real
        web article about the ${MARKER} ${topic} and its archipelago habitat.
      </p>`;
}

function rootHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Site Fixture ${MARKER} — Home</title>
    <meta name="description" content="A hermetic site-ingest test fixture" />
  </head>
  <body>
    <article>
      <h1>Site Fixture ${MARKER} — Home</h1>
      ${bodyParagraphs("home overview")}
      <nav>
        <a href="/about">About the ${MARKER} archipelago</a>
        <a href="/research">Research on ${MARKER} photosynthesis</a>
      </nav>
    </article>
  </body>
</html>`;
}

function aboutHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Site Fixture ${MARKER} — About</title>
    <meta name="description" content="About page for the hermetic fixture" />
  </head>
  <body>
    <article>
      <h1>Site Fixture ${MARKER} — About</h1>
      ${bodyParagraphs("about section")}
      <p><a href="/">Back to the ${MARKER} home page</a></p>
    </article>
  </body>
</html>`;
}

function researchHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Site Fixture ${MARKER} — Research</title>
    <meta name="description" content="Research page for the hermetic fixture" />
  </head>
  <body>
    <article>
      <h1>Site Fixture ${MARKER} — Research</h1>
      ${bodyParagraphs("research findings")}
      <p><a href="/about">See the ${MARKER} about page</a></p>
    </article>
  </body>
</html>`;
}

describe("siteIngest: hermetic whole-site crawl + index + search", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;
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

    // Force file-backed store + deterministic stub embeddings.
    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-siteingest-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OCTORYN_SCOUT_EMBEDDING_PROVIDER = "stub";
    // The SSRF guard blocks private/loopback IPs by default; the fixture is
    // served on 127.0.0.1, so opt into private hosts before importing the
    // module (which reads config lazily off process.env). Restored in afterEach.
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";

    // Serve three interlinked pages (and an empty robots.txt) on localhost.
    const root = rootHtml();
    const about = aboutHtml();
    const research = researchHtml();
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (path === "/about") {
        res.end(about);
      } else if (path === "/research") {
        res.end(research);
      } else {
        res.end(root);
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
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

  it("crawls a small interlinked site, indexes it, and finds it via search", { timeout: 30_000 }, async (ctx) => {
    if (!canBind) {
      // Could not bind a localhost socket in this sandbox; skip gracefully
      // (no network or server means nothing to assert).
      ctx.skip();
      return;
    }

    // Import AFTER env is set so config-driven singletons pick up the temp dir
    // + stub provider.
    const { ingestSite } = await import("../src/knowledge/siteIngest.js");
    const { searchKnowledge } = await import("../src/knowledge/retrieval.js");

    const result = await ingestSite({ url: baseUrl!, maxDepth: 1, maxPages: 3 });

    // Well-formed SiteIngestResult.
    expect(result.rootUrl).toContain("127.0.0.1");
    expect(result.pagesCrawled).toBeGreaterThanOrEqual(1);
    expect(result.pagesIndexed).toBeGreaterThanOrEqual(1);
    expect(result.chunksIndexed).toBeGreaterThan(0);
    expect(typeof result.startedAt).toBe("string");
    expect(typeof result.finishedAt).toBe("string");

    // Per-page entries are present and reference the served origin.
    expect(Array.isArray(result.pages)).toBe(true);
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    const indexedPages = result.pages.filter((p) => p.indexed);
    expect(indexedPages.length).toBeGreaterThanOrEqual(1);
    for (const p of result.pages) {
      expect(p.url).toContain("127.0.0.1");
      expect(typeof p.chunks).toBe("number");
    }
    // At least one indexed page actually produced chunks.
    expect(indexedPages.some((p) => p.chunks > 0)).toBe(true);

    // The distinctive prose is retrievable from the freshly built index.
    const search = await searchKnowledge({ query: DISTINCTIVE_QUERY, topK: 5 });

    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits.length).toBeLessThanOrEqual(5);
    const top = search.hits[0];
    expect(top.sourceUrl).toContain("127.0.0.1");
    // The stub embedder is hash-based, not semantic, so the cosine score sign is
    // arbitrary — only assert it is a finite number.
    expect(Number.isFinite(top.score)).toBe(true);
  });
});
