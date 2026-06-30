import { loadConfig } from "../config.js";
import { scrapeUrl } from "../ingest/pipeline.js";
import { readSitemap } from "../sitemap.js";
import { getCrawlStore } from "./crawlStore.js";
import type { CrawlJobState, CrawlPageResult, CrawlRequest, CrawlResult, ScrapeResult } from "../types.js";
import { normalizeUrl } from "../utils/url.js";

interface FrontierEntry {
  url: string;
  depth: number;
}

/**
 * Depth-bounded BFS crawler. Seeds the root URL (and optionally sitemap URLs)
 * at depth 0, scrapes pages via the ingest pipeline, and expands the frontier
 * with discovered links that pass origin/pattern filters. Per-page failures are
 * recorded rather than aborting the crawl. Backends degrade gracefully because
 * scrapeUrl/readSitemap handle their own fallbacks.
 */
export async function crawl(input: CrawlRequest): Promise<CrawlResult> {
  const config = loadConfig();
  const checkpointEvery = Math.max(1, config.crawlCheckpointEvery);

  const maxDepth = input.maxDepth ?? config.crawlMaxDepth;
  const maxPages = input.maxPages ?? config.crawlMaxPages;
  const concurrency = Math.max(1, input.concurrency ?? config.crawlConcurrency);
  const sameOriginOnly = input.sameOriginOnly ?? true;
  const includeSubdomains = input.includeSubdomains ?? false;
  const useSitemap = input.useSitemap ?? true;

  const includePatterns = compilePatterns(input.includePatterns);
  const excludePatterns = compilePatterns(input.excludePatterns);

  const rootUrl = normalizeUrl(input.url);

  // --- Persistence: load (resume) or create a new crawl job ----------------
  const store = getCrawlStore();
  await store.init();

  let state: CrawlJobState | undefined;
  let resumed = false;
  if (input.resumeCrawlId) {
    try {
      const loaded = await store.load(input.resumeCrawlId);
      if (loaded) {
        state = loaded;
        state.status = "running";
        resumed = true;
      }
    } catch {
      // Fall back to a fresh crawl if the saved job cannot be loaded.
    }
  }
  if (!state) {
    try {
      state = await store.create(rootUrl, input);
    } catch {
      // Store unavailable: synthesize an in-memory-only state so the crawl
      // still runs (save() failures below are swallowed individually).
      const nowIso = new Date().toISOString();
      state = {
        crawlId: "",
        rootUrl,
        options: input,
        status: "running",
        frontier: [],
        visited: [],
        pages: [],
        startedAt: nowIso,
        updatedAt: nowIso
      };
    }
  }
  const job = state;
  const startedAt = job.startedAt;

  const checkpoint = async (): Promise<void> => {
    try {
      await store.save(job);
    } catch {
      // Checkpointing is best-effort; never abort the crawl on a save failure.
    }
  };

  const rootHost = hostOf(rootUrl);
  const rootRegistrable = registrableHost(rootHost);

  const passesFilter = (url: string): boolean => {
    let host: string;
    try {
      host = hostOf(url);
    } catch {
      return false;
    }
    if (sameOriginOnly && !includeSubdomains) {
      if (host !== rootHost) {
        return false;
      }
    } else if (includeSubdomains) {
      if (host !== rootRegistrable && !host.endsWith(`.${rootRegistrable}`)) {
        return false;
      }
    }
    if (excludePatterns.some((re) => re.test(url))) {
      return false;
    }
    if (includePatterns.length > 0 && !includePatterns.some((re) => re.test(url))) {
      return false;
    }
    return true;
  };

  const visited = new Set<string>(job.visited);
  const discovered = new Set<string>(job.visited);
  // Reuse the live job.pages array so checkpoints always reflect current state.
  const pages = job.pages as (CrawlPageResult & { scrapeResult?: ScrapeResult })[];

  // Frontier grouped by depth so we can process strictly breadth-first.
  let currentLevel: FrontierEntry[] = [];
  // Entries pulled for the level currently being processed; unvisited ones are
  // still pending and must be persisted so a resume does not drop them.
  let activeLevel: FrontierEntry[] = [];

  /** Sync persisted frontier + visited from the live in-memory structures. */
  const syncFrontier = (): void => {
    const pending = activeLevel.filter((e) => !visited.has(e.url));
    job.frontier = [...pending, ...currentLevel].map((e) => ({ url: e.url, depth: e.depth }));
    job.visited = Array.from(visited);
  };

  const enqueue = (rawUrl: string, depth: number): void => {
    let normalized: string;
    try {
      normalized = normalizeUrl(rawUrl);
    } catch {
      return;
    }
    if (depth > maxDepth) {
      return;
    }
    discovered.add(normalized);
    if (visited.has(normalized)) {
      return;
    }
    if (depth > 0 && !passesFilter(normalized)) {
      // Root is always allowed; filters apply to discovered URLs.
      return;
    }
    currentLevel.push({ url: normalized, depth });
  };

  if (resumed) {
    // Rehydrate the BFS queue from the saved frontier; discovered/visited and
    // pages are already seeded above.
    for (const entry of job.frontier) {
      const normalized = safeNormalize(entry.url) ?? entry.url;
      discovered.add(normalized);
      if (!visited.has(normalized)) {
        currentLevel.push({ url: normalized, depth: entry.depth });
      }
    }
  } else {
    enqueue(rootUrl, 0);

    if (useSitemap) {
      try {
        const sitemap = await readSitemap(rootUrl, { timeoutMs: config.defaultTimeoutMs });
        for (const loc of sitemap.urls) {
          if (passesFilter(safeNormalize(loc) ?? loc)) {
            enqueue(loc, 0);
          }
        }
      } catch {
        // Best-effort: ignore sitemap failures.
      }
    }
    syncFrontier();
    await checkpoint();
  }

  let attempted = pages.length;
  let processedSinceCheckpoint = 0;

  try {
    for (let depth = 0; depth <= maxDepth; depth++) {
      // Pull all not-yet-visited entries at this depth, de-duplicated.
      const levelEntries: FrontierEntry[] = [];
      const seenThisLevel = new Set<string>();
      for (const entry of currentLevel) {
        if (entry.depth !== depth) {
          continue;
        }
        if (visited.has(entry.url) || seenThisLevel.has(entry.url)) {
          continue;
        }
        seenThisLevel.add(entry.url);
        levelEntries.push(entry);
      }
      // Reset frontier; deeper links discovered while processing get re-added.
      currentLevel = currentLevel.filter((e) => e.depth > depth);
      activeLevel = levelEntries;

      if (levelEntries.length === 0) {
        continue;
      }

      const nextLinks: { href: string; depth: number }[] = [];

      await runPool(levelEntries, concurrency, async (entry) => {
        if (attempted >= maxPages) {
          return;
        }
        if (visited.has(entry.url)) {
          return;
        }
        visited.add(entry.url);
        attempted += 1;

        const page = await scrapePage(entry);
        // Persist only the contract shape; keep the heavy scrapeResult local for
        // link extraction so checkpoints don't serialize full scrape payloads.
        const { scrapeResult: _scrapeResult, ...cleanPage } = page;
        pages.push(cleanPage);
        processedSinceCheckpoint += 1;

        if (processedSinceCheckpoint >= checkpointEvery) {
          processedSinceCheckpoint = 0;
          syncFrontier();
          await checkpoint();
        }

        if (page.ok && page.scrapeResult && entry.depth + 1 <= maxDepth) {
          for (const link of page.scrapeResult.extraction.links) {
            if (!link.href) {
              continue;
            }
            const normalized = safeNormalize(link.href);
            if (!normalized) {
              continue;
            }
            discovered.add(normalized);
            if (!visited.has(normalized) && passesFilter(normalized)) {
              nextLinks.push({ href: normalized, depth: entry.depth + 1 });
            }
          }
        }
      });

      for (const link of nextLinks) {
        enqueue(link.href, link.depth);
      }

      if (attempted >= maxPages) {
        break;
      }
    }
  } catch (error) {
    // Fatal crawl error: persist a failed state (best-effort) then rethrow.
    syncFrontier();
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = new Date().toISOString();
    await checkpoint();
    throw error;
  }

  // Completed normally: clear the frontier and persist a final checkpoint.
  currentLevel = currentLevel.filter((e) => !visited.has(e.url));
  syncFrontier();
  job.status = "completed";
  job.finishedAt = new Date().toISOString();
  await checkpoint();

  const finishedAt = job.finishedAt;

  // Strip the internal scrapeResult before returning the contract shape.
  const cleanPages: CrawlPageResult[] = pages.map(({ scrapeResult: _ignored, ...rest }) => rest);

  const result: CrawlResult = {
    rootUrl,
    startedAt,
    finishedAt,
    pagesCrawled: cleanPages.length,
    discoveredUrls: discovered.size,
    pages: cleanPages
  };
  // Attach crawlId as an extra field (CrawlResult does not declare it, but
  // siteIngest and the API read it defensively).
  return Object.assign(result, { crawlId: job.crawlId });

  async function scrapePage(entry: FrontierEntry): Promise<CrawlPageResult & { scrapeResult?: ScrapeResult }> {
    try {
      const result = await scrapeUrl({
        url: entry.url,
        render: input.render,
        respectRobots: input.respectRobots
      });
      return {
        url: entry.url,
        depth: entry.depth,
        status: result.fetch.status,
        ok: result.fetch.ok,
        snapshotId: result.cache.snapshotId,
        contentHash: result.evidence.contentHash,
        title: result.extraction.title,
        duplicate: result.cache.dedup?.duplicate,
        scrapeResult: result
      };
    } catch (error) {
      return {
        url: entry.url,
        depth: entry.depth,
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

/** Run `worker` over `items` with at most `limit` concurrent executions. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  };
  const size = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: size }, () => runNext()));
}

function compilePatterns(patterns?: string[]): RegExp[] {
  if (!patterns || patterns.length === 0) {
    return [];
  }
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push(new RegExp(pattern));
    } catch {
      // Skip invalid regex rather than failing the crawl.
    }
  }
  return compiled;
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function safeNormalize(url: string): string | undefined {
  try {
    return normalizeUrl(url);
  } catch {
    return undefined;
  }
}

/**
 * Approximate registrable host (eTLD+1) without a public-suffix list: take the
 * last two labels. Good enough for same-site subdomain matching in practice.
 */
function registrableHost(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) {
    return host;
  }
  return labels.slice(-2).join(".");
}
