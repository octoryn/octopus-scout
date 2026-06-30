import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * Regression coverage for the C1 fix: the `envBool` parser in src/config.ts that
 * replaced `z.coerce.boolean()`. The old `z.coerce.boolean()` is `Boolean(v)`, so
 * ANY non-empty string — including "false"/"0"/"no"/"off" — coerced to `true`,
 * which silently turned `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=false` into "SSRF guard
 * OFF". The false-branch of envBool (the "0"/"false"/"no"/"off" -> false mapping)
 * was previously UNCOVERED, so the exact bug class could regress unnoticed.
 *
 * These tests are hermetic: loadConfig is always called with an explicit, inline
 * env object (a partial NodeJS.ProcessEnv). process.env is never mutated.
 */

const envFor = (key: string, value?: string): NodeJS.ProcessEnv =>
  (value === undefined ? {} : { [key]: value }) as NodeJS.ProcessEnv;

// Tokens that envBool must treat as false (covers the previously-untested
// false-branch) plus inputs that fall through to the default (false).
const FALSY_INPUTS: Array<{ label: string; value?: string }> = [
  { label: '"false"', value: "false" },
  { label: '"0"', value: "0" },
  { label: '"no"', value: "no" },
  { label: '"off"', value: "off" },
  { label: '"FALSE" (case-insensitive)', value: "FALSE" },
  { label: '" false " (whitespace trimmed)', value: " false " },
  { label: '"garbage" (unrecognized -> default)', value: "garbage" },
  { label: '"" (empty -> default)', value: "" },
  { label: "unset (-> default)", value: undefined }
];

// Tokens that envBool must treat as true.
const TRUTHY_INPUTS: Array<{ label: string; value: string }> = [
  { label: '"true"', value: "true" },
  { label: '"1"', value: "1" },
  { label: '"yes"', value: "yes" },
  { label: '"on"', value: "on" },
  { label: '"TRUE" (case-insensitive)', value: "TRUE" }
];

// Each entry: an envBool-backed config field and its corresponding env var.
const BOOL_FIELDS: Array<{ field: "allowPrivateHosts" | "stealth" | "scheduleEnabled"; envVar: string }> = [
  { field: "allowPrivateHosts", envVar: "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS" },
  { field: "stealth", envVar: "OCTORYN_SCOUT_STEALTH" },
  { field: "scheduleEnabled", envVar: "OCTORYN_SCOUT_SCHEDULE_ENABLED" }
];

describe("loadConfig envBool parsing", () => {
  for (const { field, envVar } of BOOL_FIELDS) {
    describe(`${field} (${envVar})`, () => {
      for (const { label, value } of FALSY_INPUTS) {
        it(`is false when ${envVar}=${label}`, () => {
          const config = loadConfig(envFor(envVar, value));
          expect(config[field]).toBe(false);
        });
      }

      for (const { label, value } of TRUTHY_INPUTS) {
        it(`is true when ${envVar}=${label}`, () => {
          const config = loadConfig(envFor(envVar, value));
          expect(config[field]).toBe(true);
        });
      }
    });
  }

  it("documents the C1 regression: 'false' must NOT coerce to true (old z.coerce.boolean() would have)", () => {
    // With the OLD parser, z.coerce.boolean()("false") === Boolean("false") === true,
    // which disabled the SSRF guard. The fixed envBool maps "false" -> false.
    const config = loadConfig(envFor("OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS", "false"));
    expect(config.allowPrivateHosts).toBe(false);
    // Sanity: the broken behavior we are guarding against.
    expect(Boolean("false")).toBe(true);
    expect(config.allowPrivateHosts).not.toBe(Boolean("false"));
  });
});
