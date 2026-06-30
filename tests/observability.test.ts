import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getMetrics,
  recordBytes,
  recordDedupHit,
  recordDomain,
  recordGovernance,
  recordRequest,
  recordStatus,
  resetMetrics,
  toPrometheus
} from "../src/metrics.js";
import { checkReadiness } from "../src/health.js";

describe("metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("records counters, domains, uptime and renders Prometheus", () => {
    recordRequest("fetch");
    recordRequest("fetch");
    recordStatus(200);
    recordStatus(404);
    recordGovernance("allowed");
    recordDedupHit();
    recordBytes(1000);
    recordDomain("a.com");

    const snap = getMetrics();

    expect(snap.counters.request_fetch).toBe(2);
    expect(snap.counters.status_2xx).toBeGreaterThanOrEqual(1);
    expect(snap.counters.status_4xx).toBeGreaterThanOrEqual(1);
    expect(snap.counters.governance_allowed).toBe(1);
    expect(snap.counters.dedup_hits).toBe(1);
    expect(snap.counters.bytes_total).toBe(1000);

    expect(snap.domains["a.com"]).toBe(1);

    expect(typeof snap.uptimeSeconds).toBe("number");
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const prom = toPrometheus();
    expect(typeof prom).toBe("string");
    expect(prom).toContain("octopus_scout");
  });
});

describe("health", () => {
  let savedRedisUrl: string | undefined;
  let savedDatabaseUrl: string | undefined;

  beforeEach(() => {
    savedRedisUrl = process.env.REDIS_URL;
    savedDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  });

  it("reports ok with a process check and an ISO checkedAt, never throwing", async () => {
    const report = await checkReadiness();

    expect(report.ok).toBe(true);

    const processCheck = report.checks.find((c) => c.name === "process");
    expect(processCheck).toBeDefined();
    expect(processCheck?.ok).toBe(true);

    expect(typeof report.checkedAt).toBe("string");
    expect(report.checkedAt).toBe(new Date(report.checkedAt).toISOString());
  });
});
