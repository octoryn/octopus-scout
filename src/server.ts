import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyError } from "fastify";
import { loadConfig } from "./config.js";
import { renderResource } from "./browser/browserPool.js";
import { canFetchUrl } from "./fetcher/robots.js";
import { fetchResource } from "./fetcher/httpFetcher.js";
import { scrapeUrl } from "./ingest/pipeline.js";
import { mapSite } from "./crawl/siteMap.js";
import {
  approvalDecisionSchema,
  approvalListQuerySchema,
  auditListQuerySchema,
  crawlRequestSchema,
  exportRequestSchema,
  fetchRequestSchema,
  ingestRequestSchema,
  mapRequestSchema,
  refreshRequestSchema,
  retentionRequestSchema,
  scrapeRequestSchema,
  searchRequestSchema,
  siteIngestRequestSchema,
  sitemapRequestSchema,
  structuredExtractRequestSchema
} from "./ingest/schema.js";
import { enqueueCrawl, enqueueScrape, enqueueSiteIngest, getJobInfo } from "./queue/scrapeQueue.js";
import { crawl } from "./crawl/crawler.js";
import { getCrawlStore } from "./crawl/crawlStore.js";
import { buildRagDocument } from "./knowledge/ragExport.js";
import { ingestSite } from "./knowledge/siteIngest.js";
import { ingestUrl, searchKnowledge } from "./knowledge/retrieval.js";
import { getVectorStore } from "./knowledge/vectorStore.js";
import { extractFromUrl } from "./extract/llmExtract.js";
import { runRetention } from "./storage/retention.js";
import { createAuthHook } from "./auth.js";
import { getAuditLog } from "./governance/auditLog.js";
import { getApprovalStore } from "./governance/approvalStore.js";
import { applyApprovalDecision } from "./governance/approvalDecision.js";
import { applyPolicy } from "./governance/policy.js";
import { readSitemap } from "./sitemap.js";
import { createSnapshotStore } from "./storage/snapshotStore.js";
import { getMetrics, toPrometheus } from "./metrics.js";
import { checkReadiness } from "./health.js";
import { emitEvent, recentEvents } from "./events/eventBus.js";
import { getWebhookDeliveries, initWebhooks } from "./events/webhooks.js";
import { runStalenessSweep, startScheduler } from "./schedule/scheduler.js";
import type { ScoutEventType, SnapshotRecord } from "./types.js";

export async function buildServer() {
  const app = Fastify({ logger: true });
  const store = createSnapshotStore();
  await store.init();

  await app.register(cors, { origin: true });

  // API-key auth (no-op when authMode is "off" or no keys configured).
  app.addHook("onRequest", createAuthHook());

  // Best-effort startup: wire webhook delivery to the event bus and start the
  // staleness scheduler. Both no-op when unconfigured/disabled and never throw.
  let stopWebhooks: () => void = () => {};
  let stopScheduler: () => void = () => {};
  try {
    stopWebhooks = initWebhooks();
  } catch {
    // webhook init must never break server startup
  }
  try {
    stopScheduler = startScheduler();
  } catch {
    // scheduler start must never break server startup
  }
  app.addHook("onClose", async () => {
    try {
      stopWebhooks();
    } catch {
      /* best-effort */
    }
    try {
      stopScheduler();
    } catch {
      /* best-effort */
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: "octopus-scout",
    version: "0.1.0"
  }));

  app.get("/metrics", async (request, reply) => {
    const snap = getMetrics();
    const query = request.query as { format?: string };
    if (query.format === "prometheus") {
      return reply.header("content-type", "text/plain; version=0.0.4").send(toPrometheus(snap));
    }
    return reply.send(snap);
  });

  app.get("/ready", async (_request, reply) => {
    const report = await checkReadiness();
    if (!report.ok) {
      return reply.code(503).send(report);
    }
    return reply.send(report);
  });

  app.post("/fetch", async (request, reply) => {
    const body = fetchRequestSchema.parse(request.body);
    // Domain-policy gate: block / require_approval domains never reach the wire.
    const gate = applyPolicy(body.url, { status: "allowed", reasons: [], policyVersion: "none" });
    if (gate.status !== "allowed") {
      return reply.code(451).send({
        error: gate.status === "blocked" ? "governance_blocked" : "requires_approval",
        governanceStatus: gate.status,
        message: `governance policy denied fetch (${gate.status}); reasons: ${gate.reasons.join("; ")}`
      });
    }
    const robots = await canFetchUrl(body.url, body.respectRobots);
    if (!robots.allowed) {
      throw Object.assign(new Error(robots.reason), { statusCode: 451 });
    }
    const resource = await fetchResource(body.url, { timeoutMs: body.timeoutMs });
    return {
      url: resource.url,
      finalUrl: resource.finalUrl,
      status: resource.status,
      ok: resource.ok,
      contentType: resource.contentType,
      headers: resource.headers,
      fetchedAt: resource.fetchedAt,
      elapsedMs: resource.elapsedMs,
      bytes: resource.body.byteLength
    };
  });

  app.post("/render", async (request, reply) => {
    const body = fetchRequestSchema
      .extend({
        waitForSelector: scrapeRequestSchema.shape.waitForSelector,
        includeScreenshot: scrapeRequestSchema.shape.includeScreenshot,
        actions: scrapeRequestSchema.shape.actions
      })
      .parse(request.body);
    // Domain-policy gate: block / require_approval domains never get rendered.
    const gate = applyPolicy(body.url, { status: "allowed", reasons: [], policyVersion: "none" });
    if (gate.status !== "allowed") {
      return reply.code(451).send({
        error: gate.status === "blocked" ? "governance_blocked" : "requires_approval",
        governanceStatus: gate.status,
        message: `governance policy denied render (${gate.status}); reasons: ${gate.reasons.join("; ")}`
      });
    }
    const robots = await canFetchUrl(body.url, body.respectRobots);
    if (!robots.allowed) {
      throw Object.assign(new Error(robots.reason), { statusCode: 451 });
    }
    const resource = await renderResource(body.url, body);
    return {
      url: resource.url,
      finalUrl: resource.finalUrl,
      status: resource.status,
      ok: resource.ok,
      contentType: resource.contentType,
      fetchedAt: resource.fetchedAt,
      elapsedMs: resource.elapsedMs,
      bytes: resource.body.byteLength,
      screenshotBase64: resource.screenshotBase64,
      actionScreenshots: resource.actionScreenshots
    };
  });

  app.post("/scrape", async (request) => scrapeUrl(scrapeRequestSchema.parse(request.body)));

  app.post("/sitemap", async (request) => {
    const body = sitemapRequestSchema.parse(request.body);
    return readSitemap(body.url, body);
  });

  app.post("/map", async (request) => {
    const body = mapRequestSchema.parse(request.body);
    return mapSite(body);
  });

  app.post("/jobs/scrape", async (request, reply) => {
    const body = scrapeRequestSchema.parse(request.body);
    const job = await enqueueScrape(body);
    return reply.code(202).send(job);
  });

  app.post("/crawl", async (request) => {
    const body = crawlRequestSchema.parse(request.body);
    return crawl(body);
  });

  app.post("/jobs/crawl", async (request, reply) => {
    const body = crawlRequestSchema.parse(request.body);
    const job = await enqueueCrawl(body);
    return reply.code(202).send(job);
  });

  app.post("/jobs/ingest-site", async (request, reply) => {
    const body = siteIngestRequestSchema.parse(request.body);
    const job = await enqueueSiteIngest(body);
    return reply.code(202).send(job);
  });

  app.get("/jobs/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { queue?: string };
    const info = await getJobInfo(query.queue ?? "scrape", params.id);
    if (!info) {
      return reply.code(404).send({ error: "job not found" });
    }
    return info;
  });

  app.get("/crawls", async (request) => {
    const query = request.query as { limit?: string };
    const limit = query.limit !== undefined ? Number.parseInt(query.limit, 10) : undefined;
    return getCrawlStore().list(limit);
  });

  app.get("/crawls/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const state = await getCrawlStore().load(params.id);
    if (!state) {
      return reply.code(404).send({ error: "crawl job not found" });
    }
    return state;
  });

  app.post("/ingest-site", async (request) => {
    const body = siteIngestRequestSchema.parse(request.body);
    return ingestSite(body);
  });

  app.get("/versions", async (request, reply) => {
    const query = request.query as { url?: string; limit?: string };
    if (!query.url) {
      return reply.code(400).send({ error: "url query parameter is required" });
    }
    const limit = query.limit !== undefined ? Number.parseInt(query.limit, 10) : undefined;
    return store.listVersionsByUrl(query.url, limit);
  });

  app.post("/export", async (request, reply) => {
    const body = exportRequestSchema.parse(request.body);
    const result = await scrapeUrl({ url: body.url, forceRefresh: body.forceRefresh });
    // Only "allowed" content is exportable: never build a RAG document for
    // blocked or pending-approval sources.
    const status = result.evidence.governance.status;
    if (status !== "allowed") {
      return reply.code(403).send({
        error: status === "blocked" ? "governance_blocked" : "requires_approval",
        governanceStatus: status,
        message:
          status === "blocked"
            ? "export denied: source is governance-blocked"
            : "export denied: source is pending approval"
      });
    }
    const doc = await buildRagDocument(result, {
      maxTokens: body.maxTokens,
      overlapTokens: body.overlapTokens,
      embed: body.embed
    });
    return reply.send(doc);
  });

  app.post("/ingest", async (request) => ingestUrl(ingestRequestSchema.parse(request.body)));

  app.post("/search", async (request) => searchKnowledge(searchRequestSchema.parse(request.body)));

  // Governance "blocked" and "no provider configured" come back as 200 with
  // skipped:true (data:{}); only thrown provider errors become 500.
  app.post("/extract", async (request) => extractFromUrl(structuredExtractRequestSchema.parse(request.body)));

  app.get("/governance/approvals", async (request) => {
    const query = approvalListQuerySchema.parse(request.query);
    return getApprovalStore().list(query.status, query.limit);
  });

  app.get("/governance/approvals/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const record = await getApprovalStore().get(params.id);
    if (!record) {
      return reply.code(404).send({ error: "approval not found" });
    }
    return record;
  });

  app.post("/governance/approvals/:id/decision", async (request, reply) => {
    const params = request.params as { id: string };
    const body = approvalDecisionSchema.parse(request.body);
    const record = await getApprovalStore().decide(params.id, body.decision, body.decidedBy, body.note);
    if (!record) {
      return reply.code(404).send({ error: "approval not found" });
    }
    await getAuditLog().record({
      actor: body.decidedBy,
      action: "approval.decide",
      target: record.url,
      status: body.decision,
      detail: { approvalId: params.id, note: body.note }
    });
    // Make the decision have teeth on the durable layers: approve releases the
    // chunks (or indexes them if they were quarantined in enforce mode); reject
    // purges BOTH the index and the persisted snapshot. Mutation failures are
    // audited and surfaced (never silently swallowed).
    const effect = await applyApprovalDecision(record, body.decision, {
      vectorStore: getVectorStore(),
      snapshotStore: store,
      ingestUrl: (input) => ingestUrl(input),
      recordAudit: (event) => getAuditLog().record(event)
    });
    if (effect.error) {
      reply.header("x-governance-effect-error", "true");
    }
    try {
      emitEvent({
        type: "approval.decided",
        target: record.url,
        data: { approvalId: params.id, decision: body.decision, decidedBy: body.decidedBy }
      });
    } catch {
      // best-effort
    }
    return record;
  });

  app.get("/audit", async (request) => {
    const query = auditListQuerySchema.parse(request.query);
    return getAuditLog().list({ target: query.target, action: query.action, limit: query.limit });
  });

  app.post("/admin/retention", async (request) => {
    const body = retentionRequestSchema.parse(request.body ?? {});
    return runRetention(body);
  });

  app.post("/admin/refresh", async (request) => {
    const body = refreshRequestSchema.parse(request.body ?? {});
    return runStalenessSweep(body);
  });

  app.get("/events", async (request) => {
    const query = request.query as { type?: string; limit?: string };
    const limit = query.limit !== undefined ? Number.parseInt(query.limit, 10) : undefined;
    return recentEvents({
      type: query.type as ScoutEventType | undefined,
      limit: Number.isNaN(limit as number) ? undefined : limit
    });
  });

  app.get("/webhooks", async (request) => {
    const query = request.query as { limit?: string };
    const limit = query.limit !== undefined ? Number.parseInt(query.limit, 10) : undefined;
    return getWebhookDeliveries(Number.isNaN(limit as number) ? undefined : limit);
  });

  app.get("/snapshots/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const snapshot = await store.getById(params.id);
    if (!snapshot) {
      return reply.code(404).send({ error: "snapshot not found" });
    }
    const status = snapshot.result.evidence.governance.status;
    const query = request.query as { includeUnapproved?: string };
    const includeUnapproved = query.includeUnapproved === "true";
    // Withhold the body of non-allowed snapshots unless a reviewer opts in.
    if (status !== "allowed" && !includeUnapproved) {
      return redactSnapshotBody(snapshot);
    }
    return snapshot;
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    // Request-validation failures (zod) are client errors, not server errors —
    // map them to 400 rather than the default 500. ZodError carries no
    // statusCode, so without this they'd surface as 500.
    const isValidationError = error.name === "ZodError" || (error as { code?: string }).code === "FST_ERR_VALIDATION";
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : isValidationError ? 400 : 500;

    // Never leak internal error detail on 5xx — send a generic message while
    // preserving the error name. Client errors (<500) still echo the message.
    let message = statusCode >= 500 ? "internal server error" : error.message;

    // SSRF private-host guard: nudge the operator toward the dev escape hatch.
    // Gate on statusCode < 500 so a 5xx never re-leaks error.message through the
    // hint (defense-in-depth; UrlNotAllowedError is 400 today, so the live path
    // is unchanged).
    if (statusCode < 500 && error.name === "UrlNotAllowedError" && /private address/i.test(error.message)) {
      message = `${error.message} (set OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true to allow private hosts (dev only))`;
    }

    reply.code(statusCode).send({
      error: error.name,
      message
    });
  });

  return app;
}

/**
 * Return a copy of a snapshot with its body withheld: blank the extracted
 * markdown/text/links/images/tables and drop fetched html/screenshots. Metadata,
 * governanceStatus, and a guidance note are preserved so reviewers know how to
 * see the full record (?includeUnapproved=true).
 */
function redactSnapshotBody(snapshot: SnapshotRecord): SnapshotRecord & { note: string } {
  const result = snapshot.result;
  return {
    ...snapshot,
    result: {
      ...result,
      fetch: {
        ...result.fetch,
        html: undefined,
        screenshotBase64: undefined,
        actionScreenshots: undefined
      },
      extraction: {
        ...result.extraction,
        textContent: "",
        markdown: "",
        links: [],
        images: [],
        tables: []
      }
    },
    note: "body withheld pending approval; pass ?includeUnapproved=true to view"
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = await buildServer();
  await app.listen({ host: config.host, port: config.port });
}
