import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic tests for the LLM structured-extraction layer (src/extract/llmExtract.ts).
 *
 * The default ("none") path runs entirely offline: a tiny node:http server on
 * 127.0.0.1 serves a single HTML page (plus an empty /robots.txt), the file-
 * backed store is rooted in a unique OS temp dir (no DATABASE_URL), and ALL
 * provider keys are removed from the environment so getExtractionProvider()
 * falls back to NoneExtractionProvider. Because the module caches the provider
 * in a module-scoped singleton and loadConfig() reads lazily off process.env,
 * env is mutated BEFORE a vi.resetModules() + dynamic import.
 *
 * A separate, GATED live test (skipped unless OPENAI_API_KEY is present) drives
 * the real OpenAI extraction over the same served page.
 */

const MARKER = `octo-extract-${randomUUID().slice(0, 8)}`;
const PAGE_TITLE = `Extraction Fixture ${MARKER}`;

function fixtureHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <title>${PAGE_TITLE}</title>
    <meta name="description" content="A hermetic extraction test fixture" />
  </head>
  <body>
    <article>
      <h1>${PAGE_TITLE}</h1>
      <p>
        This fixture page exists purely so the ingestion pipeline can produce a
        meaningful Readability article body and the chunker can run. The
        distinctive marker ${MARKER} appears throughout so search and extraction
        cannot collide with anything else on disk during a hermetic test run.
      </p>
      <p>
        The document describes a fictional research log about the ${MARKER}
        archipelago, providing several sentences of stable prose so the
        extraction layer has real markdown to operate over deterministically.
      </p>
    </article>
  </body>
</html>`;
}

describe("llmExtract: provider selection + hermetic extractFromUrl", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;
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
    snapshotEnv("OCTORYN_SCOUT_DATA_DIR", "DATABASE_URL", "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS", ...PROVIDER_KEYS);

    dataDir = await mkdtemp(join(tmpdir(), "octopus-scout-llmextract-"));
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    // No provider selected, no keys -> NoneExtractionProvider.
    for (const k of PROVIDER_KEYS) delete process.env[k];
    // The fixture is served on loopback; the SSRF guard blocks private hosts
    // by default, so opt in before importing the module under test.
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";

    const html = fixtureHtml();
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
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

  it("getExtractionProvider() returns NoneExtractionProvider when unset / no keys", async () => {
    vi.resetModules();
    const { getExtractionProvider, NoneExtractionProvider } = await import("../src/extract/llmExtract.js");

    const provider = getExtractionProvider();
    expect(provider.name).toBe("none");
    expect(provider.model).toBe("none");
    expect(provider).toBeInstanceOf(NoneExtractionProvider);
    // Cached singleton: a second call returns the same instance.
    expect(getExtractionProvider()).toBe(provider);
  });

  it("NoneExtractionProvider.extract() rejects (never invoked for real)", async () => {
    vi.resetModules();
    const { NoneExtractionProvider } = await import("../src/extract/llmExtract.js");

    const provider = new NoneExtractionProvider();
    await expect(
      provider.extract({
        markdown: "irrelevant",
        schema: { type: "object" },
        sourceUrl: "http://127.0.0.1/"
      })
    ).rejects.toThrow(/no extraction provider/i);
  });

  it(
    "extractFromUrl() returns a skipped result (no provider) without hitting any LLM",
    { timeout: 30_000 },
    async (ctx) => {
      if (!canBind) {
        // No loopback socket in this sandbox; nothing to serve or assert.
        ctx.skip();
        return;
      }

      vi.resetModules();
      const { extractFromUrl } = await import("../src/extract/llmExtract.js");

      const result = await extractFromUrl({
        url: baseUrl!,
        schema: {
          type: "object",
          properties: { title: { type: "string" } }
        }
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toMatch(/no extraction provider/i);
      expect(result.provider).toBe("none");
      expect(result.data).toEqual({});
      expect(result.sourceUrl).toContain("127.0.0.1");
    }
  );

  // GATED live test: only runs when a real OpenAI key is present. Hits the real
  // OpenAI API over the hermetically served localhost page.
  describe.skipIf(!process.env.OPENAI_API_KEY)("live OpenAI extraction", () => {
    it("extracts a non-empty title from the served page", { timeout: 60_000 }, async (ctx) => {
      if (!canBind) {
        ctx.skip();
        return;
      }

      // Re-enable the real key (beforeEach stripped all provider keys) and
      // select the OpenAI provider, then import AFTER env is set.
      process.env.OPENAI_API_KEY = prev.OPENAI_API_KEY;
      process.env.OCTORYN_SCOUT_EXTRACTION_PROVIDER = "openai";
      vi.resetModules();
      const { extractFromUrl, getExtractionProvider } = await import("../src/extract/llmExtract.js");

      expect(getExtractionProvider().name).toBe("openai");

      const result = await extractFromUrl({
        url: baseUrl!,
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"]
        },
        prompt: "Extract the page title."
      });

      expect(result.skipped).toBeFalsy();
      expect(result.provider).toBe("openai");
      expect(typeof result.data.title).toBe("string");
      expect((result.data.title as string).length).toBeGreaterThan(0);
    });
  });
});
