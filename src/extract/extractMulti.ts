import { mapSite } from "../crawl/siteMap.js";
import { extractFromUrl } from "./llmExtract.js";
import type { StructuredExtractionResult } from "../types.js";

/**
 * Multi-URL and whole-site structured extraction (cf. Firecrawl /extract over a
 * list of URLs or a discovered site). Each per-URL extraction is delegated to
 * {@link extractFromUrl}, which owns the governance gate and best-effort
 * persistence — so nothing here re-checks governance or persists directly.
 */

/**
 * Extract structured data from each of `urls`, returning one result per input
 * URL (order preserved). Runs sequentially to keep concurrency modest and
 * because {@link extractFromUrl} reuses the scrape cache. A single URL failure
 * is captured as a skipped result rather than aborting the batch.
 */
export async function extractFromUrls(input: {
  urls: string[];
  schema: Record<string, unknown>;
  prompt?: string;
  forceRefresh?: boolean;
}): Promise<StructuredExtractionResult[]> {
  const results: StructuredExtractionResult[] = [];
  for (const url of input.urls) {
    try {
      results.push(
        await extractFromUrl({
          url,
          schema: input.schema,
          prompt: input.prompt,
          forceRefresh: input.forceRefresh
        })
      );
    } catch (error) {
      // Per-URL failure: surface a skipped result so the batch stays aligned
      // 1:1 with the input URLs instead of aborting.
      results.push({
        sourceUrl: url,
        finalUrl: url,
        provider: "none",
        data: {},
        governanceStatus: "allowed",
        skipped: true,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

/**
 * Discover URLs across a site (reusing {@link mapSite}, capped at `maxPages`)
 * then run {@link extractFromUrls} over the discovered set. Returns the number
 * of pages discovered alongside the per-page extraction results.
 *
 * Note: discovery uses the fast sitemap + root-link mapper, which is breadth-
 * based and bounded by a URL limit rather than a crawl depth; `maxDepth` is
 * accepted for API symmetry with crawl-based ingestion but does not deepen the
 * cheap map (mapSite does not recurse per-page).
 */
export async function extractFromSite(input: {
  url: string;
  schema: Record<string, unknown>;
  prompt?: string;
  forceRefresh?: boolean;
  maxPages?: number;
  maxDepth?: number;
  includeSubdomains?: boolean;
  search?: string;
}): Promise<{ pagesDiscovered: number; results: StructuredExtractionResult[] }> {
  const map = await mapSite({
    url: input.url,
    limit: input.maxPages,
    search: input.search,
    includeSubdomains: input.includeSubdomains
  });

  const urls = input.maxPages !== undefined ? map.urls.slice(0, input.maxPages) : map.urls;

  const results = await extractFromUrls({
    urls,
    schema: input.schema,
    prompt: input.prompt,
    forceRefresh: input.forceRefresh
  });

  return { pagesDiscovered: urls.length, results };
}
