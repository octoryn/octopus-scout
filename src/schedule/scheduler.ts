import { loadConfig } from "../config.js";
import { createSnapshotStore } from "../storage/snapshotStore.js";
import { ingestUrl } from "../knowledge/retrieval.js";
import { withLock, closeLock } from "../queue/lock.js";
import type { StalenessItem, StalenessSweepResult } from "../types.js";

const SCHEDULER_SWEEP_LOCK_KEY = "octoryn:scheduler:sweep";

/**
 * Scheduled staleness refresh.
 *
 * `runStalenessSweep` examines stored URLs, finds those whose latest snapshot
 * is older than the configured max age, and re-ingests them (forceRefresh) so
 * the knowledge index stays current. Every operation is best-effort: a single
 * URL failure (network, governance block, etc.) is recorded and the sweep
 * continues. The scheduler never throws and never keeps the process alive
 * (the interval is unref'd).
 */

const SECONDS_PER_DAY = 86_400;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Scan stored URLs (capped at `limit`) and refresh any whose latest snapshot
 * is older than `maxAgeDays`. Returns a summary; never throws on a per-URL
 * failure — failures are accumulated into the result.
 */
export async function runStalenessSweep(opts?: { maxAgeDays?: number; limit?: number }): Promise<StalenessSweepResult> {
  const config = loadConfig();
  const maxAgeDays = opts?.maxAgeDays ?? config.stalenessMaxAgeDays;
  const limit = opts?.limit ?? config.refreshLimit;
  const maxAgeSeconds = maxAgeDays * SECONDS_PER_DAY;
  const ranAt = nowIso();

  const items: StalenessItem[] = [];
  let scanned = 0;
  let refreshed = 0;
  let failures = 0;

  let urls: string[] = [];
  try {
    const store = createSnapshotStore();
    await store.init();
    urls = (await store.listUrls()).slice(0, Math.max(0, limit));

    for (const url of urls) {
      scanned += 1;
      let ageSeconds = Number.POSITIVE_INFINITY;
      try {
        const latest = await store.getLatestByUrl(url);
        if (latest) {
          const createdMs = Date.parse(latest.createdAt);
          if (!Number.isNaN(createdMs)) {
            ageSeconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
          }
        }
      } catch {
        // Treat an unreadable latest snapshot as stale so it gets refreshed.
        ageSeconds = Number.POSITIVE_INFINITY;
      }

      if (ageSeconds <= maxAgeSeconds) {
        continue;
      }

      // Stale: attempt a forced re-ingest.
      const item: StalenessItem = {
        url,
        ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : maxAgeSeconds + 1,
        refreshed: false
      };
      try {
        const ingest = await ingestUrl({ url, forceRefresh: true });
        if (ingest.skipped) {
          item.refreshed = false;
          item.reason = ingest.reason ?? `governance:${ingest.governanceStatus}`;
          failures += 1;
        } else {
          item.refreshed = true;
          refreshed += 1;
        }
      } catch (err) {
        item.refreshed = false;
        item.reason = err instanceof Error ? err.message : String(err);
        failures += 1;
      }
      items.push(item);
    }
  } catch (err) {
    // Store-level failure (e.g. init/listUrls). Degrade to an empty-ish sweep.
    void err;
  }

  return { scanned, refreshed, failures, ranAt, items };
}

let intervalHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Start the background staleness scheduler. If scheduling is disabled in
 * config, this is a no-op and returns a no-op stop function. The interval is
 * unref'd so it never keeps the process alive, and per-tick errors are
 * swallowed. Returns a function that stops the scheduler.
 */
export function startScheduler(): () => void {
  const config = loadConfig();
  if (!config.scheduleEnabled) {
    return () => {};
  }

  // Idempotent: clear any existing interval before starting a new one.
  stopScheduler();

  const lockTtlMs = config.schedulerLockTtlMs;
  const handle = setInterval(() => {
    // Wrap the scheduled tick in a distributed lock so that, across multiple
    // instances, only one runs the sweep per tick. `acquired:false` means a
    // peer holds the lock right now; skip this tick quietly. The lock degrades
    // to run-anyway when Redis is unavailable (single-instance correctness).
    void withLock(SCHEDULER_SWEEP_LOCK_KEY, lockTtlMs, () => runStalenessSweep()).catch(() => {
      // best-effort: swallow tick errors
    });
  }, config.refreshIntervalMs);

  if (typeof handle.unref === "function") {
    handle.unref();
  }
  intervalHandle = handle;

  return () => {
    stopScheduler();
  };
}

/** Stop any running scheduler interval. Idempotent. */
export function stopScheduler(): void {
  if (intervalHandle !== undefined) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
  // Disconnect the lazily-created distributed-lock client (best-effort; no-op
  // when no client was ever created). Never throws.
  void closeLock();
}
