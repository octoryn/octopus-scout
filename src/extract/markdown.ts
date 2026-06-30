import { JSDOM } from "jsdom";
import TurndownService from "turndown";

export function htmlToMarkdown(html: string): string {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  for (const node of document.querySelectorAll("script, style, noscript, svg, canvas")) {
    node.remove();
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-"
  });

  turndown.addRule("removeEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => ""
  });

  return normalizeMarkdown(turndown.turndown(document.body.innerHTML));
}

export function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
