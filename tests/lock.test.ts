import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic tests for the no-redis (single-instance) path of the queue lock.
 *
 * REDIS_URL is deleted so getRedisClient() returns null and withLock takes the
 * "always run" branch: no ioredis connection is ever attempted, so the tests
 * touch no network/redis. The lock module caches its client at module scope, so
 * we vi.resetModules() and dynamic-import a fresh graph in each test to keep the
 * cached state from leaking between cases. loadConfig() reads process.env at
 * call time, so clearing REDIS_URL before import is sufficient.
 */

type LockModule = typeof import("../src/queue/lock.js");

async function importLock(): Promise<LockModule> {
  vi.resetModules();
  return import("../src/queue/lock.js");
}

describe("withLock (no-redis single-instance path)", () => {
  let savedRedisUrl: string | undefined;

  beforeEach(() => {
    savedRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    if (savedRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = savedRedisUrl;
    }
  });

  it("returns { acquired: true, result } and actually runs fn", async () => {
    const { withLock } = await importLock();
    const fn = vi.fn(async () => 42);

    const outcome = await withLock("k:run", 1_000, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.acquired).toBe(true);
    expect(outcome.result).toBe(42);
  });

  it("uses the fn return value as result (object identity preserved)", async () => {
    const { withLock } = await importLock();
    const payload = { value: "hello", nested: { n: 1 } };

    const outcome = await withLock("k:identity", 500, async () => payload);

    expect(outcome.acquired).toBe(true);
    expect(outcome.result).toBe(payload);
  });

  it("does not swallow errors thrown by fn (the call rejects)", async () => {
    const { withLock } = await importLock();
    const boom = new Error("fn blew up");
    const fn = vi.fn(async () => {
      throw boom;
    });

    await expect(withLock("k:throw", 1_000, fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("closeLock() resolves without redis (no client ever created)", async () => {
    const { closeLock } = await importLock();
    await expect(closeLock()).resolves.toBeUndefined();
    // Safe to call again as a no-op.
    await expect(closeLock()).resolves.toBeUndefined();
  });

  it("two sequential withLock calls both acquire (no redis = always run)", async () => {
    const { withLock } = await importLock();
    const fnA = vi.fn(async () => "a");
    const fnB = vi.fn(async () => "b");

    const first = await withLock("k:shared", 1_000, fnA);
    const second = await withLock("k:shared", 1_000, fnB);

    expect(first).toEqual({ acquired: true, result: "a" });
    expect(second).toEqual({ acquired: true, result: "b" });
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});
