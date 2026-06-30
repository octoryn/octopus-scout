import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Hermetic test for the framework-agnostic retriever adapter
 * (searchAsDocuments). Mirrors tests/retrieval.test.ts: a localhost http server
 * serves a fixture page, the deterministic stub embedding provider is forced
 * (no provider keys), and the file-backed vector store is rooted in a unique OS
 * temp dir (no DATABASE_URL). We ingest the fixture, then assert
 * searchAsDocuments returns LangChain-Document-shaped objects.
 */

const MARKER = `wombat-${randomUUID().slice(0, 8)}`;
const DISTINCTIVE_QUERY = `${MARKER} photosynthesis archipelago`;

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Integration Fixture ${MARKER}</title>
    <meta name="description" content="A hermetic integrations test fixture" />
  </head>
  <body>
    <article>
      <h1>Integration Fixture ${MARKER}</h1>
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

describe("integrations: searchAsDocuments (stub embeddings, file store)", () => {
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

    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-integrations-"));
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

  it("ingests a fixture then returns LangChain-Document-shaped objects", async (ctx) => {
    if (!canBind) {
      ctx.skip();
      return;
    }

    // Import AFTER env is set so config-driven singletons pick up the temp dir.
    const { ingestUrl } = await import("../src/knowledge/retrieval.js");
    const { searchAsDocuments } = await import("../src/integrations.js");

    const ingest = await ingestUrl({ url: pagePath! });
    expect(ingest.skipped).not.toBe(true);
    expect(ingest.chunksIndexed).toBeGreaterThan(0);

    const docs = await searchAsDocuments({ query: DISTINCTIVE_QUERY, topK: 3 });

    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.length).toBeLessThanOrEqual(3);

    const top = docs[0];
    // LangChain Document shape: pageContent (string) + metadata object.
    expect(typeof top.pageContent).toBe("string");
    expect(top.pageContent.length).toBeGreaterThan(0);
    expect(typeof top.metadata).toBe("object");
    expect(top.metadata).not.toBeNull();

    // Required governance/provenance metadata is carried through.
    expect(top.metadata.sourceUrl).toBe(ingest.sourceUrl);
    expect(typeof top.metadata.sourceUrl).toBe("string");
    expect(top.metadata.governanceStatus).toBe("allowed");
  });

  it("returns an empty array when nothing matches an un-ingested corpus", async (ctx) => {
    if (!canBind) {
      ctx.skip();
      return;
    }

    const { searchAsDocuments } = await import("../src/integrations.js");
    const docs = await searchAsDocuments({ query: DISTINCTIVE_QUERY, topK: 3 });
    expect(docs).toEqual([]);
  });
});
