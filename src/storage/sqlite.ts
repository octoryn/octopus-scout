import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";

import type { AppConfig } from "../config.js";

/**
 * better-sqlite3 is a NATIVE module shipped as an OPTIONAL dependency: on the
 * common platforms npm fetches a prebuilt binary, but on an exotic platform
 * with no prebuilt and no build toolchain it may be absent. We therefore load
 * it LAZILY through a try/catch (a top-level `import` would crash this module
 * — and every store selector that imports it — the moment the binary is
 * missing). `undefined` = not yet attempted, `null` = attempted and
 * unavailable. When unavailable, the default backend degrades to "file" so the
 * app still runs with zero infrastructure.
 */
const nativeRequire = createRequire(import.meta.url);
let driver: typeof Database | null | undefined;
let warnedUnavailable = false;

function loadDriver(): typeof Database | null {
  if (driver !== undefined) return driver;
  try {
    driver = nativeRequire("better-sqlite3") as typeof Database;
  } catch {
    driver = null;
  }
  return driver;
}

/** Whether the native better-sqlite3 driver could be loaded on this platform. */
export function isSqliteAvailable(): boolean {
  return loadDriver() !== null;
}

/**
 * Test seam: force the driver to a stub or to `null` (to exercise the
 * unavailable-platform fallback) without uninstalling the package. Pass
 * `undefined` to reset back to a fresh real load attempt.
 */
export function __setSqliteDriverForTests(value: typeof Database | null | undefined): void {
  driver = value;
  warnedUnavailable = false;
}

/**
 * Connection management for the shared SQLite backend.
 *
 * A single database file (`octopus-scout.db`) lives under `config.dataDir`.
 * All five stores (snapshot, crawl, vector, lexical, governance/audit) share
 * the SAME connection so WAL works correctly and transactions interleave
 * predictably. Connections are cached by their resolved absolute path.
 *
 * This module is connection-management ONLY. It defines NO table schemas —
 * each store creates its own tables with `CREATE TABLE IF NOT EXISTS` in its
 * constructor.
 */

const connectionCache = new Map<string, Database.Database>();

/** Resolved absolute path of the single SQLite database file for a config. */
function sqliteDbPath(config: AppConfig): string {
  return resolve(join(config.dataDir, "octopus-scout.db"));
}

/**
 * Open (or return the cached) shared SQLite database for the given config.
 * The `dataDir` is created recursively if missing. On first open, WAL mode,
 * a busy timeout, and foreign-key enforcement are enabled.
 */
export function getSqliteDb(config: AppConfig): Database.Database {
  const path = sqliteDbPath(config);
  const cached = connectionCache.get(path);
  if (cached) return cached;

  const Driver = loadDriver();
  if (!Driver) {
    throw new Error(
      "better-sqlite3 is not available on this platform. Set OCTORYN_SCOUT_STORAGE_BACKEND=file " +
        "(JSON fallback) or DATABASE_URL=postgres://... — or install a build toolchain so the native module can build."
    );
  }

  mkdirSync(config.dataDir, { recursive: true });

  const db = new Driver(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  connectionCache.set(path, db);
  return db;
}

/**
 * Close all cached connections and clear the cache. FOR TESTS — each store
 * test calls this in `beforeEach` to get a fresh database.
 */
export function resetSqliteDbCache(): void {
  for (const db of connectionCache.values()) {
    try {
      db.close();
    } catch {
      // Ignore close failures (e.g. already closed) during test teardown.
    }
  }
  connectionCache.clear();
}

/**
 * Decide which storage backend to use:
 * - "postgres" when a DATABASE_URL is configured (takes precedence),
 * - "file" when explicitly opted in via OCTORYN_SCOUT_STORAGE_BACKEND=file,
 * - "sqlite" otherwise (the default; covers "auto" and "sqlite") — UNLESS the
 *   native better-sqlite3 driver cannot be loaded on this platform, in which
 *   case it degrades to "file" with a one-time warning so the app still runs.
 *
 * The five store selectors call this to pick their concrete implementation.
 */
export function resolveStorageBackend(config: AppConfig): "postgres" | "sqlite" | "file" {
  if (config.databaseUrl) return "postgres";
  if (config.storageBackend === "file") return "file";
  if (isSqliteAvailable()) return "sqlite";
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    const requested = config.storageBackend === "sqlite" ? "OCTORYN_SCOUT_STORAGE_BACKEND=sqlite was set but " : "";
    console.warn(
      `[octopus-scout] ${requested}the native better-sqlite3 driver is unavailable on this platform; ` +
        "falling back to the file storage backend. Install a build toolchain to enable SQLite, set " +
        "OCTORYN_SCOUT_STORAGE_BACKEND=file to silence this, or set DATABASE_URL to use Postgres."
    );
  }
  return "file";
}
