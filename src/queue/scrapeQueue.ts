import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { loadConfig } from "../config.js";
import { scrapeUrl } from "../ingest/pipeline.js";
import { crawl } from "../crawl/crawler.js";
import { ingestSite, type SiteIngestInput } from "../knowledge/siteIngest.js";
import type { CrawlRequest, CrawlResult, JobInfo, ScrapeRequest, ScrapeResult, SiteIngestResult } from "../types.js";

const queueName = "octoryn.web-ingestion.scrape";
const crawlQueueName = "octoryn.web-ingestion.crawl";
const siteIngestQueueName = "octoryn.web-ingestion.site";
const deadLetterQueueName = "octoryn.web-ingestion.dead";

export function createScrapeQueue() {
  const connection = createRedisConnection();
  return new Queue(queueName, { connection });
}

export async function enqueueScrape(input: ScrapeRequest): Promise<{ id: string | undefined }> {
  const queue = createScrapeQueue();
  const job = await queue.add("scrape", input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 100,
    removeOnFail: false
  });
  await queue.close();
  return { id: job.id };
}

export function createScrapeWorker(): Worker<ScrapeRequest, ScrapeResult> {
  const connection = createRedisConnection();
  return new Worker<ScrapeRequest, ScrapeResult>(queueName, async (job: Job<ScrapeRequest>) => scrapeUrl(job.data), {
    connection,
    concurrency: 3
  });
}

export function createCrawlQueue() {
  const connection = createRedisConnection();
  return new Queue(crawlQueueName, { connection });
}

export async function enqueueCrawl(input: CrawlRequest): Promise<{ id: string | undefined }> {
  const queue = createCrawlQueue();
  const job = await queue.add("crawl", input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 100,
    removeOnFail: false
  });
  await queue.close();
  return { id: job.id };
}

export function createCrawlWorker(): Worker<CrawlRequest, CrawlResult> {
  const connection = createRedisConnection();
  return new Worker<CrawlRequest, CrawlResult>(crawlQueueName, async (job: Job<CrawlRequest>) => crawl(job.data), {
    connection,
    concurrency: 1
  });
}

export function createSiteIngestQueue() {
  const connection = createRedisConnection();
  return new Queue(siteIngestQueueName, { connection });
}

export async function enqueueSiteIngest(input: SiteIngestInput): Promise<{ id: string | undefined }> {
  const queue = createSiteIngestQueue();
  const job = await queue.add("site-ingest", input, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 100,
    removeOnFail: false
  });
  await queue.close();
  return { id: job.id };
}

export function createSiteIngestWorker(): Worker<SiteIngestInput, SiteIngestResult> {
  const connection = createRedisConnection();
  return new Worker<SiteIngestInput, SiteIngestResult>(
    siteIngestQueueName,
    async (job: Job<SiteIngestInput>) => ingestSite(job.data),
    { connection, concurrency: 2 }
  );
}

export function createDeadLetterQueue() {
  const connection = createRedisConnection();
  return new Queue(deadLetterQueueName, { connection });
}

export function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const statusCode =
    error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
  const lower = message.toLowerCase();

  if (statusCode === 451 || lower.includes("robots") || lower.includes("disallow")) {
    return "robots_blocked";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return "timeout";
  }
  if (lower.includes("render") || lower.includes("page") || lower.includes("browser") || lower.includes("navigation")) {
    return "render_error";
  }
  if ((statusCode !== undefined && statusCode >= 400) || lower.includes("http") || lower.includes("status")) {
    return "http_error";
  }
  return "unknown";
}

export async function moveToDeadLetter(kind: string, data: unknown, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const record = {
    kind,
    data,
    failure: classifyFailure(error),
    error: message,
    at: new Date().toISOString()
  };
  try {
    const queue = createDeadLetterQueue();
    await queue.add("dead", record, { removeOnComplete: false, removeOnFail: false });
    await queue.close();
  } catch {
    // Dead-letter persistence is best-effort; never throw from the failure path.
  }
}

const queueNameByShortName: Record<string, string> = {
  scrape: queueName,
  crawl: crawlQueueName,
  site: siteIngestQueueName,
  dead: deadLetterQueueName
};

/**
 * Look up a persistent job by its id within one of the known queues
 * ("scrape" | "crawl" | "site" | "dead"). Returns a {@link JobInfo} snapshot,
 * or `undefined` if the queue name is unknown or no such job exists. The
 * transient queue connection is always closed.
 */
export async function getJobInfo(queueName: string, id: string): Promise<JobInfo | undefined> {
  const realName = queueNameByShortName[queueName];
  if (!realName) {
    return undefined;
  }

  const connection = createRedisConnection();
  const queue = new Queue(realName, { connection });
  try {
    const job = await queue.getJob(id);
    if (!job) {
      return undefined;
    }
    const state = await job.getState();
    return {
      id: String(job.id ?? id),
      name: job.name,
      queue: queueName,
      state,
      progress:
        typeof job.progress === "number" || (typeof job.progress === "object" && job.progress !== null)
          ? (job.progress as number | Record<string, unknown>)
          : undefined,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
      returnValue: job.returnvalue,
      data: job.data,
      timestamp: job.timestamp,
      finishedOn: job.finishedOn
    };
  } finally {
    await queue.close();
  }
}

function createRedisConnection(): ConnectionOptions {
  const config = loadConfig();
  if (!config.redisUrl) {
    throw Object.assign(new Error("REDIS_URL is required for queue operations"), { statusCode: 503 });
  }
  return { url: config.redisUrl, maxRetriesPerRequest: null };
}
