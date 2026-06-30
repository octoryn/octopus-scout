import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setupEnv.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types.ts"],
      // Thresholds set ~5 points below measured coverage (2026-06-30):
      // statements 59.5%, branches 48.72%, functions 55.85%, lines 60.36%.
      // This passes today with margin while ratcheting against future regressions.
      thresholds: {
        statements: 54,
        branches: 43,
        functions: 50,
        lines: 55
      }
    }
  }
});
