import { describe, it, expect } from "vitest";
import { chunkMarkdown, estimateTokens } from "../src/knowledge/chunking.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses the ~4-chars-per-token heuristic", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("is monotonic non-decreasing as text grows", () => {
    let prev = estimateTokens("");
    let acc = "";
    for (let i = 0; i < 200; i++) {
      acc += "x";
      const cur = estimateTokens(acc);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe("chunkMarkdown - heading splitting", () => {
  it("splits a document into sections keyed by their heading path", () => {
    const md = [
      "# Title",
      "",
      "Intro paragraph under the title.",
      "",
      "## Section A",
      "",
      "Body of section A.",
      "",
      "## Section B",
      "",
      "Body of section B.",
      ""
    ].join("\n");

    const result = chunkMarkdown(md, { maxTokens: 50, overlapTokens: 0 });

    expect(result.chunkCount).toBe(result.chunks.length);
    expect(result.chunks.length).toBeGreaterThanOrEqual(3);

    const paths = result.chunks.map((c) => c.headingPath.join(" > "));
    expect(paths).toContain("Title");
    expect(paths).toContain("Title > Section A");
    expect(paths).toContain("Title > Section B");
  });

  it("emits the whole document when there are no headings", () => {
    const md = "Just some plain text with no headings at all.";
    const result = chunkMarkdown(md, { maxTokens: 100, overlapTokens: 0 });
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].headingPath).toEqual([]);
    expect(result.chunks[0].content).toBe(md);
  });

  it("assigns sequential, zero-based indices", () => {
    const md = "# A\n\nbody a\n\n# B\n\nbody b\n\n# C\n\nbody c\n";
    const result = chunkMarkdown(md, { maxTokens: 50, overlapTokens: 0 });
    const indices = result.chunks.map((c) => c.index);
    expect(indices).toEqual(indices.map((_, i) => i));
  });
});

describe("chunkMarkdown - token budgeting", () => {
  it("respects maxTokens for each emitted chunk", () => {
    // Build a large body of many paragraphs that must be split.
    const paras: string[] = [];
    for (let i = 0; i < 40; i++) {
      paras.push(`Paragraph number ${i} with some filler words to add length.`);
    }
    const md = "# Big\n\n" + paras.join("\n\n") + "\n";

    const maxTokens = 20;
    const result = chunkMarkdown(md, { maxTokens, overlapTokens: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.tokens).toBe(estimateTokens(chunk.content));
      // maxChars = maxTokens * 4; content is trimmed so it can only be <= budget.
      expect(chunk.content.length).toBeLessThanOrEqual(maxTokens * 4);
    }
  });

  it("hard-splits a single oversized paragraph", () => {
    const huge = "word ".repeat(500).trim(); // one big paragraph, no blank lines
    const md = `# Huge\n\n${huge}\n`;
    const maxTokens = 10;
    const result = chunkMarkdown(md, { maxTokens, overlapTokens: 0 });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(maxTokens * 4);
    }
  });
});

describe("chunkMarkdown - char offsets index back into the markdown", () => {
  it("charStart/charEnd slice back to the (trimmed) chunk content", () => {
    const md = [
      "# Doc",
      "",
      "First paragraph here.",
      "",
      "## Nested",
      "",
      "Second paragraph here with more text.",
      ""
    ].join("\n");

    const result = chunkMarkdown(md, { maxTokens: 50, overlapTokens: 0 });

    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeLessThanOrEqual(md.length);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
      // The offsets index back into the original markdown and recover the content.
      expect(md.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });
});

describe("chunkMarkdown - anchor mapping", () => {
  it("maps an anchor whose markdownOffset falls inside a chunk span", () => {
    const md = ["# Anchored", "", "Alpha paragraph content.", "", "## Two", "", "Beta paragraph content here."].join(
      "\n"
    );

    // Place an anchor inside the "Beta" paragraph body.
    const betaOffset = md.indexOf("Beta paragraph") + 2;
    const anchorId = "anchor-beta";

    const result = chunkMarkdown(
      md,
      { maxTokens: 50, overlapTokens: 0 },
      {
        sourceUrl: "https://example.test/page",
        contentHash: "deadbeef",
        anchors: [
          {
            id: anchorId,
            sourceUrl: "https://example.test/page",
            textQuote: "Beta paragraph content here.",
            markdownOffset: betaOffset
          }
        ]
      }
    );

    expect(result.sourceUrl).toBe("https://example.test/page");
    expect(result.contentHash).toBe("deadbeef");

    const matched = result.chunks.filter((c) => c.anchorId === anchorId);
    expect(matched.length).toBe(1);
    const chunk = matched[0];
    expect(betaOffset).toBeGreaterThanOrEqual(chunk.charStart);
    expect(betaOffset).toBeLessThan(chunk.charEnd);

    // Chunks not containing the anchor offset must not carry the anchorId.
    for (const c of result.chunks) {
      if (c.anchorId === anchorId) {
        expect(betaOffset).toBeGreaterThanOrEqual(c.charStart);
        expect(betaOffset).toBeLessThan(c.charEnd);
      }
    }
  });

  it("leaves anchorId unset when no anchor matches a chunk span", () => {
    const md = "# Plain\n\nNo anchors apply to this body.\n";
    const result = chunkMarkdown(md, { maxTokens: 50, overlapTokens: 0 });
    for (const chunk of result.chunks) {
      expect(chunk.anchorId).toBeUndefined();
    }
  });
});

describe("chunkMarkdown - determinism & defaults", () => {
  it("produces identical output across runs (deterministic ids)", () => {
    const md = "# Repeatable\n\nSame input yields same chunks.\n";
    const a = chunkMarkdown(md, { maxTokens: 50, overlapTokens: 0 }, { sourceUrl: "u" });
    const b = chunkMarkdown(md, { maxTokens: 50, overlapTokens: 0 }, { sourceUrl: "u" });
    expect(a.chunks).toEqual(b.chunks);
    expect(a.chunks[0].id).toBeTruthy();
  });

  it("handles empty markdown without throwing", () => {
    const result = chunkMarkdown("");
    expect(result.chunks).toEqual([]);
    expect(result.chunkCount).toBe(0);
  });
});
