import { join, resolve } from "node:path";
import { Redis } from "ioredis";
import pg from "pg";
import { loadConfig } from "./config.js";
import { activeEmbeddingInfo } from "./knowledge/embedding.js";
import { resolveStorageBackend } from "./storage/sqlite.js";
import type { ReadinessCheck, ReadinessReport } from "./types.js";

/**
 * Readiness probe. Always reports a "process" check (ok). When redisUrl /
 * databaseUrl are configured, performs short-lived connectivity probes against
 * each. Never throws: a failing or throwing probe becomes a check with ok=false
 * and a descriptive detail. report.ok is true only when every check is ok.
 */

const REDIS_CONNECT_TIMEOUT_MS = 1_500;
const REDIS_OVERALL_TIMEOUT_MS = 2_500;
const PG_TIMEOUT_MS = 2_500;

export async function checkReadiness(): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  checks.push({ name: "process", ok: true });

  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig();
  } catch (err) {
    checks.push({
      name: "config",
      ok: false,
      detail: errorMessage(err)
    });
  }

  if (config?.redisUrl) {
    checks.push(await checkRedis(config.redisUrl));
  }

  if (config?.databaseUrl) {
    checks.push(await checkDatabase(config.databaseUrl));
  }

  // Report the resolved storage backend. For the default embedded SQLite store
  // this is informational (ok=true with the db file path) and never flips
  // report.ok on its own; the postgres path is already probed by checkDatabase
  // above when databaseUrl is set.
  if (config) {
    const backend = resolveStorageBackend(config);
    if (backend === "sqlite") {
      const dbPath = resolve(join(config.dataDir, "octopus-scout.db"));
      checks.push({ name: "storage", ok: true, detail: `sqlite (${dbPath})` });
    } else {
      checks.push({ name: "storage", ok: true, detail: backend });
    }
  }

  // The stub embedder is a valid mode, so this never flips report.ok to false;
  // it just makes /ready visibly report when vector search is non-semantic.
  const embedding = activeEmbeddingInfo();
  checks.push({
    name: "embeddings",
    ok: true,
    detail: embedding.semantic
      ? `provider ${embedding.provider}`
      : `provider ${embedding.provider} (non-semantic stub — vector search is meaningless)`
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    checkedAt: new Date().toISOString()
  };
}

async function checkRedis(redisUrl: string): Promise<ReadinessCheck> {
  let client: Redis | undefined;
  try {
    client = new Redis(redisUrl, {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // Avoid noisy unhandled retries during a short-lived probe.
      retryStrategy: () => null
    });
    // Suppress error events so a connection failure rejects connect()/ping()
    // rather than emitting an unhandled 'error'.
    client.on("error", () => {
      /* swallowed; surfaced via rejected promise below */
    });

    await withTimeout(
      (async () => {
        await client!.connect();
        await client!.ping();
      })(),
      REDIS_OVERALL_TIMEOUT_MS,
      "redis probe timed out"
    );

    return { name: "redis", ok: true };
  } catch (err) {
    return { name: "redis", ok: false, detail: errorMessage(err) };
  } finally {
    if (client) {
      try {
        await client.quit();
      } catch {
        try {
          client.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

async function checkDatabase(databaseUrl: string): Promise<ReadinessCheck> {
  let pool: pg.Pool | undefined;
  try {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: PG_TIMEOUT_MS,
      max: 1
    });

    await withTimeout(
      (async () => {
        await pool!.query("SELECT 1");
      })(),
      PG_TIMEOUT_MS,
      "database probe timed out"
    );

    return { name: "database", ok: true };
  } catch (err) {
    return { name: "database", ok: false, detail: errorMessage(err) };
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        /* ignore */
      }
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
