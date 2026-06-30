import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { ExtractionResult, ImageExtract, LinkExtract, TableExtract } from "../types.js";
import { htmlToMarkdown, normalizeMarkdown } from "./markdown.js";

export function extractHtml(html: string, sourceUrl: string): ExtractionResult {
  const dom = new JSDOM(html, { url: sourceUrl });
  const document = dom.window.document;
  const readableDoc = document.cloneNode(true) as Document;
  const article = new Readability(readableDoc).parse();
  const selectedHtml = article?.content ?? document.body?.innerHTML ?? html;
  const markdown = appendTables(htmlToMarkdown(selectedHtml), extractTables(document));

  return {
    kind: "html",
    title: (article?.title ?? document.title) || undefined,
    byline: article?.byline ?? undefined,
    siteName: getMeta(document, "og:site_name"),
    excerpt: article?.excerpt ?? getMeta(document, "description") ?? getMeta(document, "og:description"),
    language: document.documentElement.lang || undefined,
    canonicalUrl: getCanonical(document),
    description: getMeta(document, "description") ?? getMeta(document, "og:description"),
    textContent: normalizeWhitespace(article?.textContent ?? document.body?.textContent ?? ""),
    markdown,
    links: extractLinks(document),
    images: extractImages(document),
    tables: extractTables(document),
    metadata: {
      sourceUrl,
      generator: getMeta(document, "generator"),
      publishedTime: getMeta(document, "article:published_time"),
      modifiedTime: getMeta(document, "article:modified_time")
    }
  };
}

function getMeta(document: Document, name: string): string | undefined {
  return (
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ??
    document.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ??
    undefined
  );
}

function getCanonical(document: Document): string | undefined {
  return document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
}

function extractLinks(document: Document): LinkExtract[] {
  return Array.from(document.querySelectorAll("a[href]"))
    .map((anchor) => ({
      href: new URL(anchor.getAttribute("href") ?? "", document.URL).toString(),
      text: normalizeWhitespace(anchor.textContent ?? "") || undefined
    }))
    .filter((link, index, all) => all.findIndex((item) => item.href === link.href && item.text === link.text) === index)
    .slice(0, 500);
}

function extractImages(document: Document): ImageExtract[] {
  return Array.from(document.querySelectorAll("img[src]"))
    .map((img) => {
      const figure = img.closest("figure");
      return {
        src: new URL(img.getAttribute("src") ?? "", document.URL).toString(),
        alt: img.getAttribute("alt") || undefined,
        caption: normalizeWhitespace(figure?.querySelector("figcaption")?.textContent ?? "") || undefined
      };
    })
    .filter((image, index, all) => all.findIndex((item) => item.src === image.src && item.alt === image.alt) === index)
    .slice(0, 200);
}

function extractTables(document: Document): TableExtract[] {
  return Array.from(document.querySelectorAll("table"))
    .map((table) => {
      const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map((cell) =>
        normalizeWhitespace(cell.textContent ?? "")
      );
      const rows = Array.from(table.querySelectorAll("tbody tr, tr"))
        .map((row) => Array.from(row.querySelectorAll("td")).map((cell) => normalizeWhitespace(cell.textContent ?? "")))
        .filter((row) => row.length > 0);

      return {
        caption: normalizeWhitespace(table.querySelector("caption")?.textContent ?? "") || undefined,
        headers,
        rows
      };
    })
    .filter((table) => table.headers.length > 0 || table.rows.length > 0)
    .slice(0, 100);
}

function appendTables(markdown: string, tables: TableExtract[]): string {
  if (tables.length === 0) {
    return markdown;
  }

  const renderedTables = tables.map((table, index) => {
    const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 1);
    const headers = padRow(
      table.headers.length > 0 ? table.headers : Array.from({ length: width }, (_, i) => `Column ${i + 1}`),
      width
    );
    const rows = table.rows.map((row) => padRow(row, width));
    const title = table.caption ? `Table ${index + 1}: ${table.caption}` : `Table ${index + 1}`;
    return [
      `## ${title}`,
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${row.join(" | ")} |`)
    ].join("\n");
  });

  return normalizeMarkdown([markdown, ...renderedTables].join("\n\n"));
}

function padRow(row: string[], width: number): string[] {
  return [...row, ...Array.from({ length: Math.max(0, width - row.length) }, () => "")].slice(0, width);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
