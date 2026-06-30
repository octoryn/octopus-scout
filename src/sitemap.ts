import { XMLParser } from "fast-xml-parser";
import { fetchResource } from "./fetcher/httpFetcher.js";
import type { SitemapResult } from "./types.js";
import { normalizeUrl } from "./utils/url.js";

interface SitemapOptions {
  timeoutMs?: number;
  recursive?: boolean;
  maxSitemaps?: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  textNodeName: "text"
});

export async function readSitemap(inputUrl: string, options: SitemapOptions = {}): Promise<SitemapResult> {
  const sourceUrl = normalizeUrl(inputUrl);
  const visited = new Set<string>();
  const urls = new Set<string>();
  const sitemapUrls = new Set<string>();

  async function visit(url: string): Promise<void> {
    if (visited.has(url) || visited.size >= (options.maxSitemaps ?? 5)) {
      return;
    }
    visited.add(url);

    const resource = await fetchResource(url, { timeoutMs: options.timeoutMs });
    const xml = resource.body.toString("utf8");
    const parsed = parseSitemapXml(xml, sourceUrl);

    for (const loc of parsed.urls) {
      urls.add(loc);
    }

    for (const loc of parsed.sitemapUrls) {
      sitemapUrls.add(loc);
      if (options.recursive) {
        await visit(loc);
      }
    }
  }

  await visit(sourceUrl);

  return {
    sourceUrl,
    urls: [...urls],
    sitemapUrls: [...sitemapUrls]
  };
}

export function parseSitemapXml(xml: string, sourceUrl: string): SitemapResult {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const urlset = parsed.urlset as { url?: unknown } | undefined;
  const sitemapindex = parsed.sitemapindex as { sitemap?: unknown } | undefined;

  const urls = asArray(urlset?.url)
    .map(readLoc)
    .filter((loc): loc is string => Boolean(loc));
  const sitemapUrls = asArray(sitemapindex?.sitemap)
    .map(readLoc)
    .filter((loc): loc is string => Boolean(loc));

  return {
    sourceUrl,
    urls,
    sitemapUrls
  };
}

function asArray(value: unknown): unknown[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readLoc(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) {
    return undefined;
  }
  const loc = (item as { loc?: unknown }).loc;
  if (typeof loc === "string") {
    return loc;
  }
  if (typeof loc === "object" && loc !== null && typeof (loc as { text?: unknown }).text === "string") {
    return (loc as { text: string }).text;
  }
  return undefined;
}
