import {
  createScrapeWorker,
  createCrawlWorker,
  createSiteIngestWorker,
  moveToDeadLetter
} from "./queue/scrapeQueue.js";

const scrapeWorker = createScrapeWorker();
const crawlWorker = createCrawlWorker();
const siteIngestWorker = createSiteIngestWorker();

scrapeWorker.on("completed", (job) => {
  console.log(`scrape job ${job.id} completed`);
});

scrapeWorker.on("failed", async (job, error) => {
  console.error(`scrape job ${job?.id ?? "unknown"} failed`, error);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await moveToDeadLetter("scrape", job.data, error);
  }
});

crawlWorker.on("completed", (job) => {
  console.log(`crawl job ${job.id} completed`);
});

crawlWorker.on("failed", async (job, error) => {
  console.error(`crawl job ${job?.id ?? "unknown"} failed`, error);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await moveToDeadLetter("crawl", job.data, error);
  }
});

siteIngestWorker.on("completed", (job) => {
  console.log(`site-ingest job ${job.id} completed`);
});

siteIngestWorker.on("failed", async (job, error) => {
  console.error(`site-ingest job ${job?.id ?? "unknown"} failed`, error);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await moveToDeadLetter("site", job.data, error);
  }
});

async function shutdown(): Promise<void> {
  await Promise.allSettled([scrapeWorker.close(), crawlWorker.close(), siteIngestWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
