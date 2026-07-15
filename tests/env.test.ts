import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile } from "../src/env.js";

describe("dotenv auto-loading", () => {
  it("loads .env without overriding explicit environment values", () => {
    const dir = mkdtempSync(join(tmpdir(), "octopus-scout-env-"));
    try {
      writeFileSync(
        join(dir, ".env"),
        [
          "OCTORYN_SCOUT_PORT=9999",
          "EXISTING=from-file",
          'QUOTED="hello world"',
          "export EXPORTED=yes",
          "INLINE=value # comment"
        ].join("\n")
      );
      const env: NodeJS.ProcessEnv = { EXISTING: "from-process" };
      const loaded = loadEnvFile(env, dir);
      expect(loaded).toBe(join(dir, ".env"));
      expect(env.OCTORYN_SCOUT_PORT).toBe("9999");
      expect(env.EXISTING).toBe("from-process");
      expect(env.QUOTED).toBe("hello world");
      expect(env.EXPORTED).toBe("yes");
      expect(env.INLINE).toBe("value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can be disabled explicitly", () => {
    const env: NodeJS.ProcessEnv = { OCTORYN_SCOUT_DISABLE_DOTENV: "true" };
    expect(loadEnvFile(env, process.cwd())).toBeUndefined();
  });
});
