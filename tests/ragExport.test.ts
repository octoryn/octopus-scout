import { describe, expect, it } from "vitest";
import { buildRagDocument, toJsonl } from "../src/knowledge/ragExport.js";
import { getEmbeddingProvider } from "../src/knowledge/embedding.js";
import type { ScrapeResult } from "../src/types.js";

/** Minimal, deterministic ScrapeResult fixture built inline (no network, no fs). */
function makeScrapeResult(): ScrapeResult {
  const markdown = [
    "# Octopus Facts",
    "",
    "Octopuses have three hearts and blue blood.",
    "",
    "## Intelligence",
    "",
    "They can solve puzzles and open jars to reach food."
  ].join("\n");

  return {
    request: {
      url: "https://example.com/octopus",
      render: "auto",
      respectRobots: true,
      forceRefresh: false,
      includeHtml: false,
      includeScreenshot: false
    },
    fetch: {
      url: "https://example.com/octopus",
      finalUrl: "https://example.com/octopus",
      status: 200,
      ok: true,
      contentType: "text/html",
      fetchedAt: "2026-06-30T00:00:00.000Z",
      elapsedMs: 12,
      rendered: false
    },
    extraction: {
      kind: "html",
      title: "Octopus Facts",
      textContent: markdown,
      markdown,
      links: [],
      images: [],
      tables: [],
      metadata: {}
    },
    evidence: {
      sourceUrl: "https://example.com/octopus",
      finalUrl: "https://example.com/octopus",
      capturedAt: "2026-06-30T00:00:00.000Z",
      contentHash: "deadbeefcafef00d",
      anchors: [
        {
          id: "anchor-1",
          sourceUrl: "https://example.com/octopus",
          textQuote: "three hearts",
          markdownOffset: markdown.indexOf("three hearts")
        }
      ],
      trust: { score: 0.8, label: "high", reasons: ["known-domain"] },
      governance: { status: "allowed", reasons: [], policyVersion: "v1" }
    },
    cache: { hit: false }
  };
}

describe("buildRagDocument", () => {
  it("produces chunks with document and chunk-level metadata", async () => {
    const doc = await buildRagDocument(makeScrapeResult());

    expect(doc.id).toBeTruthy();
    expect(doc.sourceUrl).toBe("https://example.com/octopus");
    expect(doc.finalUrl).toBe("https://example.com/octopus");
    expect(doc.title).toBe("Octopus Facts");
    expect(doc.contentHash).toBe("deadbeefcafef00d");
    expect(doc.capturedAt).toBe("2026-06-30T00:00:00.000Z");
    expect(doc.trust.label).toBe("high");
    expect(doc.governance.status).toBe("allowed");

    expect(doc.chunks.length).toBeGreaterThan(0);
    for (const chunk of doc.chunks) {
      expect(typeof chunk.id).toBe("string");
      expect(chunk.id.length).toBeGreaterThan(0);
      expect(typeof chunk.index).toBe("number");
      expect(typeof chunk.content).toBe("string");
      expect(chunk.tokens).toBeGreaterThan(0);
      expect(Array.isArray(chunk.headingPath)).toBe(true);
      expect(typeof chunk.charStart).toBe("number");
      expect(typeof chunk.charEnd).toBe("number");
      // No embedding unless explicitly requested.
      expect(chunk.embedding).toBeUndefined();
    }

    // Indices are contiguous starting at 0.
    expect(doc.chunks.map((c) => c.index)).toEqual(doc.chunks.map((_, i) => i));

    // Heading-aware chunking captured the section heading.
    expect(doc.chunks.some((c) => c.headingPath.includes("Octopus Facts"))).toBe(true);

    // The citation anchor falling inside a chunk span is attached.
    expect(doc.chunks.some((c) => c.anchorId === "anchor-1")).toBe(true);
  });
});

describe("toJsonl", () => {
  it("yields one valid JSON object per line with flattened doc metadata", async () => {
    const doc = await buildRagDocument(makeScrapeResult());
    const jsonl = toJsonl(doc);

    const lines = jsonl.split("\n");
    expect(lines.length).toBe(doc.chunks.length);

    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record.documentId).toBe(doc.id);
      expect(record.sourceUrl).toBe(doc.sourceUrl);
      expect(record.finalUrl).toBe(doc.finalUrl);
      expect(record.title).toBe(doc.title);
      expect(record.contentHash).toBe(doc.contentHash);
      expect(record.capturedAt).toBe(doc.capturedAt);
      expect(record.trustScore).toBe(doc.trust.score);
      expect(record.trustLabel).toBe(doc.trust.label);
      expect(record.governanceStatus).toBe(doc.governance.status);
      expect(typeof record.id).toBe("string");
      expect(typeof record.content).toBe("string");
      // Embeddings are omitted when not embedded.
      expect(record.embedding).toBeUndefined();
    }
  });
});

describe("buildRagDocument with embed:true", () => {
  it("attaches a 256-dim vector to every chunk via the stub provider", async () => {
    const dims = getEmbeddingProvider().dimensions;
    expect(dims).toBe(256);

    const doc = await buildRagDocument(makeScrapeResult(), { embed: true });

    expect(doc.chunks.length).toBeGreaterThan(0);
    for (const chunk of doc.chunks) {
      expect(Array.isArray(chunk.embedding)).toBe(true);
      expect(chunk.embedding).toHaveLength(256);
      for (const v of chunk.embedding!) {
        expect(typeof v).toBe("number");
        expect(Number.isFinite(v)).toBe(true);
      }
    }

    // Stub is deterministic: same content -> same vector.
    const again = await buildRagDocument(makeScrapeResult(), { embed: true });
    expect(again.chunks[0].embedding).toEqual(doc.chunks[0].embedding);

    // Embeddings survive JSONL serialization.
    const lines = toJsonl(doc).split("\n");
    const first = JSON.parse(lines[0]) as { embedding?: number[] };
    expect(first.embedding).toHaveLength(256);
  });
});
