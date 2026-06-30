import { Redis } from "ioredis";
import { loadConfig } from "../config.js";
import { domainOf } from "../utils/url.js";

/**
 * Distributed per-domain rate limiter.
 *
 * When REDIS_URL is configured the min interval is enforced across all worker
 * processes via a single lazily-created ioredis client and an atomic EVAL
 * strategy. Each domain key stores the next-allowed epoch-ms timestamp; a
 * request reserves the next slot atomically and is told how long to wait so
 * that requests to the same domain are globally spaced >= the effective
 * interval. Any Redis error degrades gracefully to a per-process in-memory
 * path and never throws.
 */

// In-memory fallback: last-request-time per domain (per-process).
const lastRequestByDomain = new Map<string, number>();

// Recorded robots crawl-delay per domain (ms). Process-local; the effective
// interval combines this with the caller-supplied minIntervalMs.
const crawlDelayByDomain = new Map<string, number>();

// Lazily-created shared Redis client. `undefined` = not yet attempted,
// `null` = no redisUrl / permanently disabled for this process.
let redisClient: Redis | null | undefined;
let redisDisabled = false;

/**
 * Atomic reserve-next-slot script.
 *
 * KEYS[1] = per-domain key holding the next-allowed epoch ms.
 * ARGV[1] = now (epoch ms)
 * ARGV[2] = effective interval ms
 * ARGV[3] = key TTL seconds (to let idle domains expire)
 *
 * Returns the number of ms the caller must wait before issuing its request.
 */
const reserveSlotScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local nextAllowed = tonumber(redis.call('GET', key))
local slot
if nextAllowed == nil or nextAllowed < now then
  slot = now
else
  slot = nextAllowed
end

redis.call('SET', key, slot + interval, 'PX', (interval + ttl * 1000))
return slot - now
`;

function getRedisClient(): Redis | null {
  if (redisClient !== undefined) {
    return redisClient;
  }
  if (redisDisabled) {
    redisClient = null;
    return redisClient;
  }

  const config = loadConfig();
  if (!config.redisUrl) {
    redisClient = null;
    return redisClient;
  }

  try {
    const client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false
    });
    // Prevent unhandled error events from crashing the process; we degrade
    // gracefully on every command instead.
    client.on("error", () => {
      /* swallow: per-command try/catch handles fallback */
    });
    redisClient = client;
  } catch {
    redisDisabled = true;
    redisClient = null;
  }
  return redisClient;
}

function effectiveIntervalMs(domain: string, minIntervalMs: number): number {
  const crawlDelay = crawlDelayByDomain.get(domain) ?? 0;
  return Math.max(minIntervalMs, crawlDelay);
}

async function waitViaRedis(client: Redis, domain: string, intervalMs: number): Promise<boolean> {
  try {
    const key = `octoryn.scout.ratelimit:${domain}`;
    const now = Date.now();
    const raw = await client.eval(reserveSlotScript, 1, key, String(now), String(intervalMs), "60");
    const waitMs = Math.max(0, Number(raw) || 0);
    if (waitMs > 0) {
      await delay(waitMs);
    }
    return true;
  } catch {
    return false;
  }
}

function waitViaMemory(domain: string, intervalMs: number): Promise<void> {
  const now = Date.now();
  const last = lastRequestByDomain.get(domain) ?? 0;
  const waitMs = Math.max(0, last + intervalMs - now);
  // Reserve this slot immediately so concurrent calls in this process queue up.
  lastRequestByDomain.set(domain, Math.max(now, last) + intervalMs);
  return waitMs > 0 ? delay(waitMs) : Promise.resolve();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDomainSlot(url: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) {
    return;
  }

  const domain = domainOf(url);
  const intervalMs = effectiveIntervalMs(domain, minIntervalMs);
  if (intervalMs <= 0) {
    return;
  }

  const client = getRedisClient();
  if (client) {
    const handled = await waitViaRedis(client, domain, intervalMs);
    if (handled) {
      return;
    }
  }

  await waitViaMemory(domain, intervalMs);
}

export function noteCrawlDelay(url: string, delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }
  const domain = domainOf(url);
  const existing = crawlDelayByDomain.get(domain) ?? 0;
  // Keep the most conservative (largest) crawl-delay observed for the domain.
  crawlDelayByDomain.set(domain, Math.max(existing, delayMs));
}

export async function closeRateLimiter(): Promise<void> {
  const client = redisClient;
  redisClient = undefined;
  redisDisabled = false;
  if (client) {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}
