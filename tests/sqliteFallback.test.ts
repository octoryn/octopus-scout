import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveStorageBackend, isSqliteAvailable, __setSqliteDriverForTests } from "../src/storage/sqlite.js";
import { loadConfig } from "../src/config.js";

/**
 * better-sqlite3 is an OPTIONAL native dependency. On a platform with no
 * prebuilt binary and no build toolchain it may be absent — `npm install` must
 * not hard-fail (optionalDependencies) and the app must still run by degrading
 * the default backend to "file". These tests force the unavailable path via the
 * __setSqliteDriverForTests seam (no need to actually uninstall the package).
 */

// Build a config from an explicit env object so we don't depend on the global
// test pin (tests/setupEnv.ts sets OCTORYN_SCOUT_STORAGE_BACKEND=file on process.env).
const cfg = (env: Record<string, string | undefined>) => loadConfig(env as NodeJS.ProcessEnv);

describe("storage backend selection with better-sqlite3 unavailable", () => {
  afterEach(() => {
    __setSqliteDriverForTests(undefined); // reset to a real load attempt
    vi.restoreAllMocks();
  });

  it("sqlite is available in this environment by default", () => {
    expect(isSqliteAvailable()).toBe(true);
    expect(resolveStorageBackend(cfg({}))).toBe("sqlite");
  });

  it('"auto" degrades to "file" (with a one-time warning) when the native driver cannot load', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    __setSqliteDriverForTests(null);
    expect(isSqliteAvailable()).toBe(false);
    expect(resolveStorageBackend(cfg({}))).toBe("file");
    expect(warn).toHaveBeenCalledTimes(1);
    // Warning is emitted only once even across repeated resolutions.
    expect(resolveStorageBackend(cfg({}))).toBe("file");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('explicit "sqlite" also degrades to "file" when the driver is unavailable', () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    __setSqliteDriverForTests(null);
    expect(resolveStorageBackend(cfg({ OCTORYN_SCOUT_STORAGE_BACKEND: "sqlite" }))).toBe("file");
  });

  it("DATABASE_URL still wins (postgres) and explicit file stays file, regardless of driver", () => {
    __setSqliteDriverForTests(null);
    expect(resolveStorageBackend(cfg({ DATABASE_URL: "postgres://x/y" }))).toBe("postgres");
    expect(resolveStorageBackend(cfg({ OCTORYN_SCOUT_STORAGE_BACKEND: "file" }))).toBe("file");
  });
});
