import { crawl } from "../crawl/crawler.js";
import { ingestUrl } from "./retrieval.js";
import { emitEvent } from "../events/eventBus.js";
import type { CrawlRequest, SiteIngestResult } from "../types.js";

/**
 * Whole-site ingestion: crawl a site, then index every successfully crawled
 * page into the vector store via {@link ingestUrl}.
 *
 * The crawl runs first; for each page that fetched OK (page.ok && !page.error)
 * we call ingestUrl. Because the page was just crawled, scrapeUrl's cache makes
 * the re-fetch cheap. Per-page failures are recorded (indexed:false + reason)
 * rather than aborting the whole site, and governance-blocked / skipped pages
 * are counted in `skipped`.
 */
export type SiteIngestInput = CrawlRequest & {
  maxTokens?: number;
  overlapTokens?: number;
};

export async function ingestSite(input: SiteIngestInput): Promise<SiteIngestResult> {
  const startedAt = new Date().toISOString();

  const crawlResult = await crawl(input);

  // crawlId is not part of the CrawlResult contract today; read defensively in
  // case a future crawler attaches one.
  const crawlId =
    typeof (crawlResult as { crawlId?: unknown }).crawlId === "string"
      ? (crawlResult as { crawlId?: string }).crawlId
      : undefined;

  const pages: SiteIngestResult["pages"] = [];
  let pagesIndexed = 0;
  let chunksIndexed = 0;
  let skipped = 0;

  for (const page of crawlResult.pages) {
    if (!page.ok || page.error) {
      // Crawl-level failure: not indexed, not counted as a governance skip.
      pages.push({
        url: page.url,
        indexed: false,
        chunks: 0,
        reason: page.error ?? "page fetch not ok"
      });
      continue;
    }

    try {
      const ingest = await ingestUrl({
        url: page.url,
        maxTokens: input.maxTokens,
        overlapTokens: input.overlapTokens
      });

      const wasIndexed = ingest.skipped !== true && ingest.chunksIndexed > 0;

      if (wasIndexed) {
        pagesIndexed += 1;
        chunksIndexed += ingest.chunksIndexed;
      } else {
        skipped += 1;
      }

      pages.push({
        url: page.url,
        indexed: wasIndexed,
        chunks: ingest.chunksIndexed,
        governanceStatus: ingest.governanceStatus,
        reason: ingest.reason
      });
    } catch (error) {
      pages.push({
        url: page.url,
        indexed: false,
        chunks: 0,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const result: SiteIngestResult = {
    crawlId,
    rootUrl: crawlResult.rootUrl,
    pagesCrawled: crawlResult.pagesCrawled,
    pagesIndexed,
    chunksIndexed,
    skipped,
    startedAt,
    finishedAt: new Date().toISOString(),
    pages
  };

  // Best-effort event emission; never let eventing break site ingestion.
  try {
    emitEvent({
      type: "site_ingest.completed",
      target: result.rootUrl,
      data: {
        crawlId: result.crawlId,
        pagesIndexed: result.pagesIndexed,
        chunksIndexed: result.chunksIndexed
      }
    });
  } catch {
    // best-effort
  }

  return result;
}
