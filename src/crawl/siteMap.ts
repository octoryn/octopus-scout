import { loadConfig } from "../config.js";
import { extractHtml } from "../extract/htmlExtractor.js";
import { fetchResource } from "../fetcher/httpFetcher.js";
import { readSitemap } from "../sitemap.js";
import type { MapRequest, MapResult } from "../types.js";
import { normalizeUrl, sameOriginUrl } from "../utils/url.js";

/**
 * Fast site URL discovery (cf. Firecrawl /map). Collects candidate URLs from two
 * cheap sources — the site's sitemap(s) and the links on the root page — without
 * scraping each page. Both sources are best-effort: a failure in one never aborts
 * the other.
 */
export async function mapSite(input: MapRequest): Promise<MapResult> {
  const config = loadConfig();
  const limit = input.limit ?? config.mapMaxUrls;

  let rootUrl: string;
  let rootHost: string;
  try {
    rootUrl = normalizeUrl(input.url);
    rootHost = new URL(rootUrl).hostname.toLowerCase();
  } catch {
    return { rootUrl: input.url, count: 0, urls: [], fromSitemap: 0, fromLinks: 0 };
  }

  // Track which normalized URLs we have already seen so each source's contribution
  // is counted exactly once (first source to surface a URL "owns" it).
  const seen = new Set<string>();
  const collected: string[] = [];
  let fromSitemap = 0;
  let fromLinks = 0;

  const includeSubdomains = input.includeSubdomains ?? false;
  const includePaths = input.includePaths ?? [];
  const excludePaths = input.excludePaths ?? [];
  const search = input.search?.toLowerCase();

  function accept(raw: string): boolean {
    let normalized: string;
    let parsed: URL;
    try {
      normalized = normalizeUrl(raw);
      parsed = new URL(normalized);
    } catch {
      return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    if (includeSubdomains) {
      if (host !== rootHost && !host.endsWith(`.${rootHost}`)) {
        return false;
      }
    } else if (host !== rootHost) {
      return false;
    }

    const pathAndSearch = `${parsed.pathname}${parsed.search}`;
    if (includePaths.length > 0 && !includePaths.some((p) => pathAndSearch.includes(p))) {
      return false;
    }
    if (excludePaths.some((p) => pathAndSearch.includes(p))) {
      return false;
    }

    if (search && !normalized.toLowerCase().includes(search)) {
      return false;
    }

    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    collected.push(normalized);
    return true;
  }

  // --- Source 1: sitemap(s) -------------------------------------------------
  if (input.useSitemap !== false) {
    const sitemapCandidates = new Set<string>();
    try {
      const result = await readSitemap(rootUrl, { recursive: true, maxSitemaps: 20 });
      for (const loc of result.urls) {
        sitemapCandidates.add(loc);
      }
    } catch {
      // ignore — sitemap may not exist or be malformed
    }
    try {
      const wellKnown = sameOriginUrl(rootUrl, "/sitemap.xml");
      const result = await readSitemap(wellKnown, { recursive: true, maxSitemaps: 20 });
      for (const loc of result.urls) {
        sitemapCandidates.add(loc);
      }
    } catch {
      // ignore — best-effort fallback
    }

    for (const loc of sitemapCandidates) {
      if (collected.length >= limit) {
        break;
      }
      if (accept(loc)) {
        fromSitemap += 1;
      }
    }
  }

  // --- Source 2: root-page links -------------------------------------------
  if (collected.length < limit) {
    try {
      const resource = await fetchResource(rootUrl);
      if (resource.ok && resource.contentType.toLowerCase().includes("html")) {
        const extraction = extractHtml(resource.body.toString("utf8"), resource.finalUrl);
        for (const link of extraction.links) {
          if (collected.length >= limit) {
            break;
          }
          if (!link.href) {
            continue;
          }
          if (accept(link.href)) {
            fromLinks += 1;
          }
        }
      }
    } catch {
      // ignore — root page may be unreachable or non-HTML
    }
  }

  const urls = collected.slice(0, limit);

  return {
    rootUrl,
    count: urls.length,
    urls,
    fromSitemap,
    fromLinks
  };
}
