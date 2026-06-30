import type { MetricsSnapshot } from "./types.js";

/**
 * Process-wide, in-memory metrics. All record functions are cheap and never
 * throw — they are safe to call on any hot path. State is module-level and
 * resets only on process restart (or explicit resetMetrics() in tests).
 */

const startedAtMs = Date.now();

interface MetricsState {
  requests: Map<string, number>;
  statusClasses: Map<string, number>;
  governance: Map<string, number>;
  dedupHits: number;
  bytesTotal: number;
  domains: Map<string, number>;
}

function freshState(): MetricsState {
  return {
    requests: new Map(),
    statusClasses: new Map(),
    governance: new Map(),
    dedupHits: 0,
    bytesTotal: 0,
    domains: new Map()
  };
}

let state: MetricsState = freshState();

/** Cap on the number of distinct domains retained (top-N by count). */
const MAX_DOMAINS = 200;

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sanitizeLabel(value: string): string {
  // Keep metric/label keys to a safe, predictable charset.
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}

export function recordRequest(kind: string): void {
  try {
    bump(state.requests, sanitizeLabel(kind));
  } catch {
    /* never throw */
  }
}

export function recordStatus(code: number): void {
  try {
    let cls: string;
    if (!Number.isFinite(code) || code <= 0) {
      cls = "other";
    } else if (code >= 200 && code < 300) {
      cls = "2xx";
    } else if (code >= 300 && code < 400) {
      cls = "3xx";
    } else if (code >= 400 && code < 500) {
      cls = "4xx";
    } else if (code >= 500 && code < 600) {
      cls = "5xx";
    } else if (code >= 100 && code < 200) {
      cls = "1xx";
    } else {
      cls = "other";
    }
    bump(state.statusClasses, cls);
  } catch {
    /* never throw */
  }
}

export function recordGovernance(status: string): void {
  try {
    bump(state.governance, sanitizeLabel(status));
  } catch {
    /* never throw */
  }
}

export function recordDedupHit(): void {
  try {
    state.dedupHits += 1;
  } catch {
    /* never throw */
  }
}

export function recordBytes(n: number): void {
  try {
    if (Number.isFinite(n) && n > 0) {
      state.bytesTotal += n;
    }
  } catch {
    /* never throw */
  }
}

export function recordDomain(domain: string): void {
  try {
    const key = (domain || "").trim().toLowerCase();
    if (!key) return;
    bump(state.domains, key);
    if (state.domains.size > MAX_DOMAINS) {
      pruneDomains();
    }
  } catch {
    /* never throw */
  }
}

/** Keep only the top MAX_DOMAINS entries by count. */
function pruneDomains(): void {
  const sorted = [...state.domains.entries()].sort((a, b) => b[1] - a[1]);
  const kept = sorted.slice(0, MAX_DOMAINS);
  state.domains = new Map(kept);
}

function topDomains(): Record<string, number> {
  const sorted = [...state.domains.entries()].sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  for (const [domain, count] of sorted.slice(0, MAX_DOMAINS)) {
    out[domain] = count;
  }
  return out;
}

export function getMetrics(): MetricsSnapshot {
  const counters: Record<string, number> = {};

  for (const [kind, n] of state.requests) {
    counters[`request_${kind}`] = n;
  }
  for (const [cls, n] of state.statusClasses) {
    counters[`status_${cls}`] = n;
  }
  for (const [status, n] of state.governance) {
    counters[`governance_${status}`] = n;
  }
  counters.dedup_hits = state.dedupHits;
  counters.bytes_total = state.bytesTotal;

  const uptimeSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));

  return {
    uptimeSeconds,
    counters,
    domains: topDomains()
  };
}

/** Render a snapshot as Prometheus text exposition format. */
export function toPrometheus(snapshot: MetricsSnapshot = getMetrics()): string {
  const lines: string[] = [];

  lines.push("# HELP octopus_scout_uptime_seconds Process uptime in seconds.");
  lines.push("# TYPE octopus_scout_uptime_seconds gauge");
  lines.push(`octopus_scout_uptime_seconds ${snapshot.uptimeSeconds}`);

  for (const [name, value] of Object.entries(snapshot.counters)) {
    const metric = `octopus_scout_${sanitizeLabel(name)}`;
    lines.push(`# TYPE ${metric} counter`);
    lines.push(`${metric} ${value}`);
  }

  for (const [domain, value] of Object.entries(snapshot.domains)) {
    lines.push(`octopus_scout_domain_requests{domain="${escapePromLabel(domain)}"} ${value}`);
  }

  return lines.join("\n") + "\n";
}

function escapePromLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Reset all metrics to zero. Intended for tests. */
export function resetMetrics(): void {
  state = freshState();
}
