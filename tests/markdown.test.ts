import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/extract/markdown.js";

describe("htmlToMarkdown", () => {
  it("removes scripts and normalizes spacing", () => {
    const markdown = htmlToMarkdown("<main><h1>Hello</h1><script>alert(1)</script><p>World</p></main>");

    expect(markdown).toBe("# Hello\n\nWorld");
  });
});
