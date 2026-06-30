import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ScrapeResult } from "../src/types.js";

/**
 * HTTP-layer tests for buildServer() exercised via app.inject (no app.listen, no
 * real network). OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true is set before the server
 * module is dynamically imported so the SSRF guard does not block the loopback
 * fixtures used by sibling tests; here we deliberately stay on validation / auth /
 * status routes and never trigger an outbound fetch.
 *
 * config + auth read env at construction time, so each app is built after the
 * desired env is in place and modules are reset (vi.resetModules + dynamic
 * import of ../src/server.js).
 *
 * Validation status codes: route handlers validate with zod's schema.parse(...),
 * which throws a ZodError. The server's error handler (src/server.ts
 * setErrorHandler) maps ZodError to HTTP 400 (a client error), with body
 * { error: "ZodError" }.
 */

const ENV_KEYS = ["OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS", "OCTORYN_SCOUT_AUTH_MODE", "OCTORYN_SCOUT_API_KEYS"] as const;

describe("buildServer HTTP layer", () => {
  const saved: Record<string, string | undefined> = {};
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
    }
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    delete process.env.OCTORYN_SCOUT_AUTH_MODE;
    delete process.env.OCTORYN_SCOUT_API_KEYS;
    vi.resetModules();
  });

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  async function buildApp(): Promise<FastifyInstance> {
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer();
    apps.push(app);
    return app;
  }

  describe("status + observability routes (auth off)", () => {
    it("GET /health -> 200 { ok: true }", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toBe("octopus-scout");
    });

    it("GET /ready -> 200 or 503 with an { ok, checks } readiness shape", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect([200, 503]).toContain(res.statusCode);
      const body = res.json();
      expect(typeof body.ok).toBe("boolean");
      expect(Array.isArray(body.checks)).toBe(true);
      // Status code and ok flag must agree.
      expect(res.statusCode === 200).toBe(body.ok === true);
    });

    it("GET /metrics -> 200 JSON snapshot", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.uptimeSeconds).toBe("number");
      expect(typeof body.counters).toBe("object");
    });

    it("GET /metrics?format=prometheus -> 200 text/plain exposition", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/metrics?format=prometheus" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.body).toContain("octopus_scout_");
    });
  });

  describe("validation + routing (auth off)", () => {
    it("POST /search with an empty body is rejected by zod validation", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/search", payload: {} });
      // Validation failures are client errors -> 400.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ZodError");
    });

    it("POST /scrape with a missing url is rejected by zod validation", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/scrape", payload: {} });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ZodError");
    });

    it("POST /scrape with a malformed url is rejected by zod validation", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/scrape", payload: { url: "not-a-url" } });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ZodError");
    });

    it("POST /extract/batch with an empty body is rejected by zod validation", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/extract/batch", payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ZodError");
    });

    it("POST /extract/batch with an empty urls array is rejected by zod validation", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/extract/batch",
        payload: { urls: [], schema: {} }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ZodError");
    });

    it("POST /extract/site with a missing url is rejected by zod validation", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/extract/site", payload: { schema: {} } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ZodError");
    });

    it("POST /extract/site with a malformed url is rejected by zod validation", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/extract/site",
        payload: { url: "not-a-url", schema: {} }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("ZodError");
    });

    it("GET /extractions -> 200 with an array (empty when nothing stored)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scout-extractions-"));
      const prev = process.env.OCTORYN_SCOUT_DATA_DIR;
      process.env.OCTORYN_SCOUT_DATA_DIR = dir;
      vi.resetModules();
      try {
        const app = await buildApp();
        const res = await app.inject({ method: "GET", url: "/extractions" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(0);
      } finally {
        if (prev === undefined) delete process.env.OCTORYN_SCOUT_DATA_DIR;
        else process.env.OCTORYN_SCOUT_DATA_DIR = prev;
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("GET /extractions/:id for an unknown id -> 404", async () => {
      const dir = await mkdtemp(join(tmpdir(), "scout-extractions-"));
      const prev = process.env.OCTORYN_SCOUT_DATA_DIR;
      process.env.OCTORYN_SCOUT_DATA_DIR = dir;
      vi.resetModules();
      try {
        const app = await buildApp();
        const res = await app.inject({ method: "GET", url: "/extractions/does-not-exist" });
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe("extraction not found");
      } finally {
        if (prev === undefined) delete process.env.OCTORYN_SCOUT_DATA_DIR;
        else process.env.OCTORYN_SCOUT_DATA_DIR = prev;
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("GET an unknown route -> 404", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/does-not-exist" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("API-key auth (authMode=write, keys=k1)", () => {
    beforeEach(() => {
      process.env.OCTORYN_SCOUT_AUTH_MODE = "write";
      process.env.OCTORYN_SCOUT_API_KEYS = "k1";
      vi.resetModules();
    });

    it("POST /search without a key -> 401 before validation runs", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/search", payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("unauthorized");
    });

    it("POST /search with a valid x-api-key is not rejected for auth (not 401)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/search",
        headers: { "x-api-key": "k1" },
        payload: {}
      });
      // Auth passed: we get past the 401 gate. Body is still invalid, so the
      // request falls through to zod validation (400), never 401.
      expect(res.statusCode).not.toBe(401);
    });

    it("GET /health stays open even under write auth", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });
});

/**
 * Governance side-channel tests: the search/index layer is no longer the only
 * gate. /export must refuse non-allowed content, /snapshots/:id must redact the
 * body of non-allowed snapshots by default, and /render + /fetch must honor the
 * domain policy before touching the wire.
 */
describe("buildServer governance gates", () => {
  const ENV = [
    "OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS",
    "OCTORYN_SCOUT_DATA_DIR",
    "DATABASE_URL",
    "OCTORYN_SCOUT_POLICY_FILE"
  ] as const;
  const saved: Record<string, string | undefined> = {};
  const apps: FastifyInstance[] = [];
  let dataDir: string;

  function makeResult(url: string, status: ScrapeResult["evidence"]["governance"]["status"]): ScrapeResult {
    return {
      request: {
        url,
        render: "auto",
        respectRobots: true,
        forceRefresh: false,
        includeHtml: false,
        includeScreenshot: false
      },
      fetch: {
        url,
        finalUrl: url,
        status: 200,
        ok: true,
        contentType: "text/html",
        fetchedAt: new Date().toISOString(),
        elapsedMs: 1,
        rendered: false,
        html: "<html><body>secret</body></html>"
      },
      extraction: {
        kind: "html",
        title: "Secret Page",
        textContent: "the secret body text",
        markdown: "# the secret body text",
        links: [{ url: "https://example.com/x", text: "x" } as never],
        images: [],
        tables: [],
        metadata: { author: "someone" }
      },
      evidence: {
        sourceUrl: url,
        finalUrl: url,
        capturedAt: new Date().toISOString(),
        contentHash: "hash-1",
        anchors: [],
        trust: { score: 0.5, label: "medium", reasons: [] },
        governance: { status, reasons: ["test"], policyVersion: "test" }
      },
      cache: { hit: false }
    };
  }

  beforeEach(async () => {
    for (const key of ENV) {
      saved[key] = process.env[key];
    }
    dataDir = await mkdtemp(join(tmpdir(), `octopus-gov-routes-${randomUUID()}-`));
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    // Domain policy: block one domain, require approval on another.
    const policyPath = join(dataDir, "policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        version: "v1",
        domains: [
          { domain: "blocked.example", action: "block" },
          { domain: "review.example", action: "require_approval" }
        ]
      })
    );
    process.env.OCTORYN_SCOUT_POLICY_FILE = policyPath;
    vi.resetModules();
  });

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
    for (const key of ENV) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  async function buildApp(): Promise<FastifyInstance> {
    const { buildServer } = await import("../src/server.js");
    const app = await buildServer();
    apps.push(app);
    return app;
  }

  it("POST /export of requires_approval content -> 403 (no RAG document built)", async () => {
    const url = "http://127.0.0.1:9/pending";
    // Seed a snapshot so scrapeUrl returns a fresh cache hit without a network fetch.
    const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
    const store = createSnapshotStore();
    await store.init();
    await store.save(makeResult(url, "requires_approval"));

    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/export", payload: { url } });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("requires_approval");
    expect(body.governanceStatus).toBe("requires_approval");
    // No RAG document fields leak through.
    expect(body.chunks).toBeUndefined();
  });

  it("GET /snapshots/:id redacts the body of a non-allowed snapshot by default", async () => {
    const url = "http://127.0.0.1:9/pending-snap";
    const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
    const store = createSnapshotStore();
    await store.init();
    const saved = await store.save(makeResult(url, "requires_approval"));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/snapshots/${saved.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.evidence.governance.status).toBe("requires_approval");
    // Body withheld.
    expect(body.result.extraction.markdown).toBe("");
    expect(body.result.extraction.textContent).toBe("");
    expect(body.result.extraction.links).toEqual([]);
    expect(body.result.fetch.html).toBeUndefined();
    expect(body.note).toContain("includeUnapproved");
    // Metadata preserved for reviewers.
    expect(body.result.extraction.title).toBe("Secret Page");
  });

  it("GET /snapshots/:id?includeUnapproved=true serves the full body", async () => {
    const url = "http://127.0.0.1:9/pending-snap2";
    const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
    const store = createSnapshotStore();
    await store.init();
    const saved = await store.save(makeResult(url, "requires_approval"));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/snapshots/${saved.id}?includeUnapproved=true` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.extraction.markdown).toBe("# the secret body text");
    expect(body.result.fetch.html).toContain("secret");
    expect(body.note).toBeUndefined();
  });

  it("GET /snapshots/:id serves an allowed snapshot in full (no redaction)", async () => {
    const url = "http://127.0.0.1:9/ok-snap";
    const { createSnapshotStore } = await import("../src/storage/snapshotStore.js");
    const store = createSnapshotStore();
    await store.init();
    const saved = await store.save(makeResult(url, "allowed"));

    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/snapshots/${saved.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.extraction.markdown).toBe("# the secret body text");
    expect(body.note).toBeUndefined();
  });

  it("POST /render of a policy-blocked domain -> 451 (never rendered)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/render", payload: { url: "https://blocked.example/x" } });
    expect(res.statusCode).toBe(451);
    const body = res.json();
    expect(body.error).toBe("governance_blocked");
    expect(body.governanceStatus).toBe("blocked");
  });

  it("POST /fetch of a require_approval domain -> 451 (never fetched)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/fetch", payload: { url: "https://review.example/x" } });
    expect(res.statusCode).toBe(451);
    const body = res.json();
    expect(body.error).toBe("requires_approval");
    expect(body.governanceStatus).toBe("requires_approval");
  });
});
