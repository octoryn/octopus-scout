import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic tests for the multi-URL / whole-site structured-extraction layer
 * (src/extract/extractMulti.ts).
 *
 * Everything runs offline: a tiny node:http server on 127.0.0.1 serves a few
 * interlinked HTML pages (each with an empty /robots.txt), the file-backed
 * stores are rooted in a unique OS temp dir (no DATABASE_URL), and ALL provider
 * keys are stripped so getExtractionProvider() falls back to
 * NoneExtractionProvider — meaning every extraction is `skipped` and NOTHING is
 * persisted. Modules read config lazily off process.env and cache singletons,
 * so env is mutated BEFORE a vi.resetModules() + dynamic import.
 */

const MARKER = `octo-multi-${randomUUID().slice(0, 8)}`;

function bodyParagraphs(topic: string): string {
  return `
      <p>
        This fixture page describes the ${MARKER} ${topic} so the ingestion
        pipeline can produce a meaningful Readability article body. The marker
        ${MARKER} appears throughout to keep this hermetic and collision-free.
      </p>
      <p>
        Additional stable prose about the ${MARKER} ${topic} ensures the
        extraction layer has real markdown to operate over deterministically.
      </p>`;
}

function rootHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Multi Fixture ${MARKER} — Home</title>
    <meta name="description" content="A hermetic extractMulti test fixture" />
  </head>
  <body>
    <article>
      <h1>Multi Fixture ${MARKER} — Home</h1>
      ${bodyParagraphs("home overview")}
      <nav>
        <a href="/about">About ${MARKER}</a>
        <a href="/research">Research ${MARKER}</a>
      </nav>
    </article>
  </body>
</html>`;
}

function pageHtml(topic: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>Multi Fixture ${MARKER} — ${topic}</title>
    <meta name="description" content="Hermetic fixture page" />
  </head>
  <body>
    <article>
      <h1>Multi Fixture ${MARKER} — ${topic}</h1>
      ${bodyParagraphs(topic)}
      <p><a href="/">Back to ${MARKER} home</a></p>
    </article>
  </body>
</html>`;
}

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } }
};

describe("extractMulti: extractFromUrls + extractFromSite (hermetic, none provider)", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;
  let host: string | undefined;
  let dataDir: string;
  let canBind = true;

  const PROVIDER_KEYS = [
    "OCTORYN_SCOUT_EXTRACTION_PROVIDER",
    "OCTORYN_SCOUT_EXTRACTION_MODEL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "VOYAGE_API_KEY",
    "COHERE_API_KEY"
  ];

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
      "OCTORYN_SCOUT_STORAGE_BACKEND",
      "OCTORYN_SCOUT_POLICY_FILE",
      "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
      ...PROVIDER_KEYS
    );

    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-extractmulti-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    process.env.OCTORYN_SCOUT_STORAGE_BACKEND = "file";
    delete process.env.DATABASE_URL;
    delete process.env.OCTORYN_SCOUT_POLICY_FILE;
    // No provider selected, no keys -> NoneExtractionProvider (skipped results).
    for (const k of PROVIDER_KEYS) delete process.env[k];
    // The fixture is served on loopback; opt past the SSRF guard.
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";

    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (path === "/about") res.end(pageHtml("About"));
      else if (path === "/research") res.end(pageHtml("Research"));
      else res.end(rootHtml());
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      host = `127.0.0.1:${addr.port}`;
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

  it(
    "extractFromUrls iterates all urls, returns one skipped result each, and persists nothing",
    { timeout: 30_000 },
    async (ctx) => {
      if (!canBind) {
        ctx.skip();
        return;
      }

      vi.resetModules();
      const { extractFromUrls } = await import("../src/extract/extractMulti.js");
      const { createExtractionStore } = await import("../src/extract/extractionStore.js");

      const urls = [`${baseUrl}/`, `${baseUrl}/about`, `${baseUrl}/research`];
      const results = await extractFromUrls({ urls, schema: SCHEMA });

      expect(results).toHaveLength(urls.length);
      for (const result of results) {
        expect(result.skipped).toBe(true);
        expect(result.reason).toMatch(/no extraction provider/i);
        expect(result.provider).toBe("none");
        expect(result.data).toEqual({});
      }
      expect(results.map((r) => r.sourceUrl)).toEqual(urls);

      // Nothing was persisted: skipped extractions must never reach the store.
      const store = createExtractionStore();
      await store.init();
      const stored = await store.list(100, { includeUnapproved: true });
      expect(stored).toHaveLength(0);
    }
  );

  it("skips blocked content (via policy.json) and persists nothing", { timeout: 30_000 }, async (ctx) => {
    if (!canBind) {
      ctx.skip();
      return;
    }

    // A policy that blocks the fixture host escalates governance to "blocked";
    // extractFromUrl returns a blocked+skipped result and must NOT persist.
    const policyPath = join(dataDir, "policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({ version: "block-v1", domains: [{ domain: "127.0.0.1", action: "block" }] }),
      "utf8"
    );
    process.env.OCTORYN_SCOUT_POLICY_FILE = policyPath;

    vi.resetModules();
    const { extractFromUrls } = await import("../src/extract/extractMulti.js");
    const { createExtractionStore } = await import("../src/extract/extractionStore.js");

    const results = await extractFromUrls({ urls: [`${baseUrl}/`], schema: SCHEMA });

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(true);
    expect(results[0].governanceStatus).toBe("blocked");
    expect(results[0].provider).toBe("none");

    const store = createExtractionStore();
    await store.init();
    expect(await store.list(100, { includeUnapproved: true })).toHaveLength(0);
  });

  it(
    "extractFromSite discovers urls and maps extraction over the localhost fixture",
    { timeout: 30_000 },
    async (ctx) => {
      if (!canBind) {
        ctx.skip();
        return;
      }

      vi.resetModules();
      const { extractFromSite } = await import("../src/extract/extractMulti.js");

      const { pagesDiscovered, results } = await extractFromSite({
        url: baseUrl!,
        schema: SCHEMA,
        maxPages: 10
      });

      // The root page links to /about and /research, so discovery finds them.
      expect(pagesDiscovered).toBeGreaterThan(0);
      expect(results).toHaveLength(pagesDiscovered);
      for (const result of results) {
        expect(result.skipped).toBe(true);
        expect(result.sourceUrl).toContain(host!);
      }
    }
  );
});
