import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Ensure the in-memory path: no REDIS_URL means getRedisClient() returns null
// and waitForDomainSlot falls back to the per-process in-memory limiter.
delete process.env.REDIS_URL;

const { waitForDomainSlot, noteCrawlDelay, closeRateLimiter } = await import("../src/fetcher/rateLimiter.js");

// Each test uses a unique domain so the process-local Maps don't leak state
// between cases, and we reset the lazily-created (null) Redis client too.
let counter = 0;
function uniqueUrl(): string {
  counter += 1;
  return `https://d${counter}-${Date.now()}.example.com/page`;
}

beforeEach(async () => {
  delete process.env.REDIS_URL;
  await closeRateLimiter();
});

afterEach(async () => {
  await closeRateLimiter();
});

describe("waitForDomainSlot (in-memory)", () => {
  it("spaces two same-domain calls by >= minIntervalMs", async () => {
    const url = uniqueUrl();
    const minIntervalMs = 50;

    // First call reserves the current slot and returns immediately.
    await waitForDomainSlot(url, minIntervalMs);

    const start = Date.now();
    await waitForDomainSlot(url, minIntervalMs);
    const elapsed = Date.now() - start;

    // Allow a small scheduler tolerance below the nominal interval.
    expect(elapsed).toBeGreaterThanOrEqual(minIntervalMs - 10);
  });

  it("does not block calls to different domains", async () => {
    const minIntervalMs = 50;
    const urlA = uniqueUrl();
    const urlB = uniqueUrl();

    await waitForDomainSlot(urlA, minIntervalMs);

    const start = Date.now();
    await waitForDomainSlot(urlB, minIntervalMs);
    const elapsed = Date.now() - start;

    // A different domain has no reserved slot, so it should return promptly.
    expect(elapsed).toBeLessThan(minIntervalMs);
  });

  it("returns immediately when minIntervalMs <= 0", async () => {
    const url = uniqueUrl();

    await waitForDomainSlot(url, 0);

    const start = Date.now();
    await waitForDomainSlot(url, 0);
    await waitForDomainSlot(url, -100);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(20);
  });

  it("raises the effective interval via noteCrawlDelay", async () => {
    const url = uniqueUrl();
    const minIntervalMs = 10;
    const crawlDelayMs = 60;

    noteCrawlDelay(url, crawlDelayMs);

    // First call reserves the slot immediately.
    await waitForDomainSlot(url, minIntervalMs);

    const start = Date.now();
    await waitForDomainSlot(url, minIntervalMs);
    const elapsed = Date.now() - start;

    // The crawl delay (60ms) dominates the smaller minIntervalMs (10ms).
    expect(elapsed).toBeGreaterThanOrEqual(crawlDelayMs - 10);
    expect(elapsed).toBeGreaterThan(minIntervalMs);
  });
});
