import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { domainOf } from "../utils/url.js";
import type { DomainPolicy, GovernanceDecision, GovernancePolicy, PolicyAction } from "../types.js";

const EMPTY_POLICY: GovernancePolicy = { version: "none", domains: [] };

interface PolicyCache {
  path: string;
  policy: GovernancePolicy;
}

let cache: PolicyCache | undefined;

/**
 * Resolve the policy file path: explicit config.policyFile, else
 * <dataDir>/policy.json.
 */
function resolvePolicyPath(): string {
  const config = loadConfig();
  if (config.policyFile && config.policyFile.trim() !== "") {
    return config.policyFile;
  }
  return join(config.dataDir, "policy.json");
}

function normalizeAction(value: unknown): PolicyAction | undefined {
  if (value === "allow" || value === "block" || value === "require_approval") {
    return value;
  }
  return undefined;
}

function coerceDomain(raw: unknown): DomainPolicy | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const domain = typeof entry.domain === "string" ? entry.domain.trim().toLowerCase() : "";
  if (domain === "") {
    return undefined;
  }
  const policy: DomainPolicy = { domain };
  const action = normalizeAction(entry.action);
  if (action) {
    policy.action = action;
  }
  if (typeof entry.rateLimitMs === "number" && Number.isFinite(entry.rateLimitMs)) {
    policy.rateLimitMs = entry.rateLimitMs;
  }
  if (typeof entry.trustOverride === "number" && Number.isFinite(entry.trustOverride)) {
    policy.trustOverride = entry.trustOverride;
  }
  if (typeof entry.note === "string") {
    policy.note = entry.note;
  }
  return policy;
}

function coercePolicy(raw: unknown): GovernancePolicy {
  if (!raw || typeof raw !== "object") {
    return EMPTY_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === "string" && obj.version.trim() !== "" ? obj.version : "none";
  const domains: DomainPolicy[] = [];
  if (Array.isArray(obj.domains)) {
    for (const entry of obj.domains) {
      const coerced = coerceDomain(entry);
      if (coerced) {
        domains.push(coerced);
      }
    }
  }
  const policy: GovernancePolicy = { version, domains };
  const defaultAction = normalizeAction(obj.defaultAction);
  if (defaultAction) {
    policy.defaultAction = defaultAction;
  }
  if (Array.isArray(obj.sensitiveKeywords)) {
    const keywords = obj.sensitiveKeywords.filter((k): k is string => typeof k === "string");
    if (keywords.length > 0) {
      policy.sensitiveKeywords = keywords;
    }
  }
  return policy;
}

/**
 * Load and cache the governance policy. Reads JSON from config.policyFile (or
 * <dataDir>/policy.json) synchronously. On any failure (missing / unreadable /
 * invalid JSON) returns a safe empty policy and never throws.
 */
export function loadPolicy(): GovernancePolicy {
  const path = resolvePolicyPath();
  if (cache && cache.path === path) {
    return cache.policy;
  }
  let policy: GovernancePolicy = EMPTY_POLICY;
  try {
    const raw = readFileSync(path, "utf8");
    policy = coercePolicy(JSON.parse(raw));
  } catch {
    policy = EMPTY_POLICY;
  }
  cache = { path, policy };
  return policy;
}

/** Clear the in-process policy cache (intended for tests). */
export function resetPolicyCache(): void {
  cache = undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return domainOf(url);
  } catch {
    return undefined;
  }
}

/**
 * Match a URL against the policy's domain rules. Matches on exact hostname or
 * suffix (host === d.domain || host.endsWith("." + d.domain)). The most
 * specific (longest domain string) match wins.
 */
export function matchDomainPolicy(url: string, policy?: GovernancePolicy): DomainPolicy | undefined {
  const resolved = policy ?? loadPolicy();
  const host = hostOf(url);
  if (!host) {
    return undefined;
  }
  let best: DomainPolicy | undefined;
  for (const candidate of resolved.domains) {
    const d = candidate.domain;
    if (d === "") {
      continue;
    }
    if (host === d || host.endsWith("." + d)) {
      if (!best || d.length > best.domain.length) {
        best = candidate;
      }
    }
  }
  return best;
}

const SEVERITY: Record<GovernanceDecision["status"], number> = {
  allowed: 0,
  requires_approval: 1,
  blocked: 2
};

function actionToStatus(action: PolicyAction): GovernanceDecision["status"] {
  switch (action) {
    case "block":
      return "blocked";
    case "require_approval":
      return "requires_approval";
    case "allow":
    default:
      return "allowed";
  }
}

/**
 * Escalate (never relax) a base governance decision using the domain policy.
 * Takes the most severe of base.status and the policy-derived status
 * (defaultAction + matched domain action). A domain "allow" never downgrades a
 * pre-existing block/approval requirement.
 */
export function applyPolicy(url: string, base: GovernanceDecision): GovernanceDecision {
  const policy = loadPolicy();
  const matched = matchDomainPolicy(url, policy);

  const reasons = [...base.reasons];
  let status = base.status;
  const policyVersion = base.policyVersion || policy.version;

  const considerAction = (action: PolicyAction | undefined, domain?: string): void => {
    if (!action) {
      return;
    }
    const candidate = actionToStatus(action);
    if (SEVERITY[candidate] > SEVERITY[status]) {
      status = candidate;
      const where = domain ? ` (${domain})` : "";
      reasons.push(`domain policy: ${action}${where}`);
    }
  };

  considerAction(policy.defaultAction);
  considerAction(matched?.action, matched?.domain);

  return {
    status,
    reasons,
    policyVersion
  };
}

/** Trust override declared by the matched domain policy, if any. */
export function policyTrustOverride(url: string): number | undefined {
  return matchDomainPolicy(url)?.trustOverride;
}

/**
 * Effective per-domain rate limit: the larger of the base delay and any
 * matched domain.rateLimitMs.
 */
export function effectiveRateLimitMs(url: string, baseMs: number): number {
  const matched = matchDomainPolicy(url);
  return Math.max(baseMs, matched?.rateLimitMs ?? 0);
}
