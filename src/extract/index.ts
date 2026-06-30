import type { ExtractionResult, FetchedResource } from "../types.js";
import { isProbablyPdf } from "../utils/url.js";
import { extractHtml } from "./htmlExtractor.js";
import { extractPdf } from "./pdfExtractor.js";
import { normalizeMarkdown } from "./markdown.js";

export async function extractResource(resource: FetchedResource): Promise<ExtractionResult> {
  if (isProbablyPdf(resource.finalUrl, resource.contentType)) {
    return extractPdf(resource.body, resource.finalUrl);
  }

  const body = resource.body.toString("utf8");
  if (resource.contentType.includes("html") || body.includes("<html")) {
    return extractHtml(body, resource.finalUrl);
  }

  const text = body.trim();
  return {
    kind: "text",
    textContent: text,
    markdown: normalizeMarkdown(text),
    links: [],
    images: [],
    tables: [],
    metadata: {
      sourceUrl: resource.finalUrl
    }
  };
}
