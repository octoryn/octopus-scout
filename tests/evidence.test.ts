import { describe, expect, it } from "vitest";
import { buildCitationAnchors, scoreSource } from "../src/evidence/evidenceBuilder.js";

describe("evidence builder", () => {
  it("creates stable citation anchors from meaningful markdown blocks", () => {
    const markdown = [
      "# Example",
      "Short line.",
      "This is a much longer paragraph that should become a citation anchor because it carries enough content to quote in downstream RAG answers."
    ].join("\n\n");

    const anchors = buildCitationAnchors(markdown, "https://example.com");

    expect(anchors).toHaveLength(2);
    expect(anchors[0].id).toMatch(/^cite_1_/);
    expect(anchors[1].textQuote).toContain("longer paragraph");
  });

  it("scores https sources with metadata as medium or better", () => {
    const trust = scoreSource("https://example.edu/report", {
      kind: "html",
      title: "Report",
      description: "Useful report",
      canonicalUrl: "https://example.edu/report",
      textContent: "A".repeat(1000),
      markdown: "A".repeat(1000),
      links: [],
      images: [],
      tables: [],
      metadata: {}
    });

    expect(trust.score).toBeGreaterThanOrEqual(0.75);
    expect(trust.label).toBe("high");
  });
});
