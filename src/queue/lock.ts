import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { loadConfig } from "../config.js";

/**
 * Redis-backed distributed lock.
 *
 * `withLock` provides mutual exclusion across worker/scheduler processes when
 * REDIS_URL is configured. The lock is acquired with `SET key <token> NX PX
 * ttlMs`; if won, the callback runs and the lock is released only if this
 * holder still owns it (atomic compare-and-del via EVAL). If another holder
 * owns the key the callback is skipped and `{ acquired: false }` is returned.
 *
 * The lock degrades gracefully: any Redis error (or no REDIS_URL configured)
 * falls back to running the callback anyway and reporting `acquired: true`,
 * which preserves correctness for a single-instance deployment. This module
 * never throws at import and never throws from a Redis failure.
 */

export interface LockResult<T> {
  acquired: boolean;
  result?: T;
}

// Lazily-created shared Redis client. `undefined` = not yet attempted,
// `null` = no redisUrl / permanently disabled for this process.
let redisClient: Redis | null | undefined;
let redisDisabled = false;

// How long to wait for the lazy connection to come up before degrading.
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Atomic compare-and-del: release the lock only if we still own it.
 *
 * KEYS[1] = lock key
 * ARGV[1] = token this holder wrote
 *
 * Returns 1 if the key was owned and deleted, 0 otherwise.
 */
const releaseScript = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

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
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      connectTimeout: CONNECT_TIMEOUT_MS
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

async function ensureConnected(client: Redis): Promise<boolean> {
  // ioredis status is "ready" once connected; with lazyConnect it starts as
  // "wait". `connect()` is a no-op (rejects) once already connecting/ready, so
  // guard on status and tolerate the benign "already connecting" rejection.
  if (isReady(client)) {
    return true;
  }
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS);
    return true;
  } catch {
    return isReady(client);
  }
}

function isReady(client: Redis): boolean {
  return String(client.status) === "ready";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("redis connect timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Run `fn` while holding a distributed lock on `key` for at most `ttlMs`.
 *
 * Returns `{ acquired: true, result }` when the work ran (either because the
 * lock was won or because Redis is unavailable and we degraded to run-anyway),
 * or `{ acquired: false }` when another holder currently owns the lock.
 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<LockResult<T>> {
  const client = getRedisClient();

  // No Redis configured: single-instance path, always run.
  if (!client) {
    const result = await fn();
    return { acquired: true, result };
  }

  const token = randomUUID();

  let owned = false;
  try {
    const connected = await ensureConnected(client);
    if (!connected) {
      // Could not reach Redis: degrade to run-anyway.
      const result = await fn();
      return { acquired: true, result };
    }

    const setResult = await client.set(key, token, "PX", Math.max(1, Math.floor(ttlMs)), "NX");
    if (setResult !== "OK") {
      // Another holder owns the lock.
      return { acquired: false };
    }
    owned = true;
  } catch {
    // Any Redis error before running: degrade to run-anyway.
    const result = await fn();
    return { acquired: true, result };
  }

  // Lock held: run the work, then best-effort release if we still own it.
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    if (owned) {
      try {
        await client.eval(releaseScript, 1, key, token);
      } catch {
        /* swallow: the lock will expire via PX TTL */
      }
    }
  }
}

/**
 * Disconnect the lazily-created lock client, if any. Safe to call when no
 * client was ever created.
 */
export async function closeLock(): Promise<void> {
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
