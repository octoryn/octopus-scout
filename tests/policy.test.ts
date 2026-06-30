import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  resetPolicyCache,
  loadPolicy,
  matchDomainPolicy,
  applyPolicy,
  effectiveRateLimitMs,
  policyTrustOverride
} from "../src/governance/policy.js";
import type { GovernanceDecision } from "../src/types.js";

const POLICY = {
  version: "test-v1",
  defaultAction: "allow",
  domains: [
    { domain: "example.com", action: "require_approval", rateLimitMs: 1000, trustOverride: 0.5 },
    { domain: "api.example.com", action: "block", rateLimitMs: 5000, trustOverride: 0.1 },
    { domain: "blocked.test", action: "block" },
    { domain: "allowed.test", action: "allow", rateLimitMs: 250 }
  ]
};

let tmpDir: string;
let policyPath: string;
const PREV_POLICY_FILE = process.env.OCTORYN_SCOUT_POLICY_FILE;

function baseDecision(overrides: Partial<GovernanceDecision> = {}): GovernanceDecision {
  return { status: "allowed", reasons: [], policyVersion: "", ...overrides };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `policy-${randomUUID()}-`));
  policyPath = join(tmpDir, "policy.json");
  writeFileSync(policyPath, JSON.stringify(POLICY), "utf8");
  process.env.OCTORYN_SCOUT_POLICY_FILE = policyPath;
  resetPolicyCache();
});

afterEach(() => {
  if (PREV_POLICY_FILE === undefined) {
    delete process.env.OCTORYN_SCOUT_POLICY_FILE;
  } else {
    process.env.OCTORYN_SCOUT_POLICY_FILE = PREV_POLICY_FILE;
  }
  resetPolicyCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadPolicy", () => {
  it("loads the policy file pointed at by OCTORYN_SCOUT_POLICY_FILE", () => {
    const policy = loadPolicy();
    expect(policy.version).toBe("test-v1");
    expect(policy.domains).toHaveLength(4);
  });
});

describe("matchDomainPolicy", () => {
  it("matches an exact hostname", () => {
    const matched = matchDomainPolicy("https://example.com/path");
    expect(matched?.domain).toBe("example.com");
  });

  it("matches on a suffix (subdomain)", () => {
    const matched = matchDomainPolicy("https://www.example.com/page");
    expect(matched?.domain).toBe("example.com");
  });

  it("most-specific (longest) match wins", () => {
    const matched = matchDomainPolicy("https://api.example.com/v1");
    expect(matched?.domain).toBe("api.example.com");
    expect(matched?.action).toBe("block");
  });

  it("returns undefined when no domain matches", () => {
    expect(matchDomainPolicy("https://nomatch.invalid/")).toBeUndefined();
  });

  it("does not match a bare suffix without a dot boundary", () => {
    // "notexample.com" should not match "example.com"
    expect(matchDomainPolicy("https://notexample.com/")).toBeUndefined();
  });
});

describe("applyPolicy", () => {
  it("escalates allowed -> requires_approval", () => {
    const decision = applyPolicy("https://example.com/", baseDecision({ status: "allowed" }));
    expect(decision.status).toBe("requires_approval");
    expect(decision.reasons.some((r) => r.includes("require_approval"))).toBe(true);
  });

  it("escalates allowed -> blocked", () => {
    const decision = applyPolicy("https://blocked.test/", baseDecision({ status: "allowed" }));
    expect(decision.status).toBe("blocked");
    expect(decision.reasons.some((r) => r.includes("block"))).toBe(true);
  });

  it("never downgrades a blocked base to allowed", () => {
    const decision = applyPolicy("https://allowed.test/", baseDecision({ status: "blocked" }));
    expect(decision.status).toBe("blocked");
  });

  it("never downgrades a blocked base when domain requires approval", () => {
    const decision = applyPolicy("https://example.com/", baseDecision({ status: "blocked" }));
    expect(decision.status).toBe("blocked");
  });

  it("never downgrades requires_approval to allowed for an allow domain", () => {
    const decision = applyPolicy("https://allowed.test/", baseDecision({ status: "requires_approval" }));
    expect(decision.status).toBe("requires_approval");
  });

  it("falls back to the policy version when base has none", () => {
    const decision = applyPolicy("https://allowed.test/", baseDecision({ policyVersion: "" }));
    expect(decision.policyVersion).toBe("test-v1");
  });
});

describe("effectiveRateLimitMs", () => {
  it("returns the base when it is larger than the domain limit", () => {
    expect(effectiveRateLimitMs("https://example.com/", 4000)).toBe(4000);
  });

  it("returns the domain limit when it is larger than the base", () => {
    expect(effectiveRateLimitMs("https://example.com/", 100)).toBe(1000);
  });

  it("returns the base when no domain matches", () => {
    expect(effectiveRateLimitMs("https://nomatch.invalid/", 300)).toBe(300);
  });
});

describe("policyTrustOverride", () => {
  it("returns the override declared by the matched domain", () => {
    expect(policyTrustOverride("https://example.com/")).toBe(0.5);
  });

  it("returns the most-specific override", () => {
    expect(policyTrustOverride("https://api.example.com/")).toBe(0.1);
  });

  it("returns undefined when no override is declared", () => {
    expect(policyTrustOverride("https://blocked.test/")).toBeUndefined();
  });

  it("returns undefined when no domain matches", () => {
    expect(policyTrustOverride("https://nomatch.invalid/")).toBeUndefined();
  });
});
