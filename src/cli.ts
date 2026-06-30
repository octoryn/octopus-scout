#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { browserPool } from "./browser/browserPool.js";
import { fetchResource } from "./fetcher/httpFetcher.js";
import { renderResource } from "./browser/browserPool.js";
import { scrapeUrl } from "./ingest/pipeline.js";
import { crawl } from "./crawl/crawler.js";
import { mapSite } from "./crawl/siteMap.js";
import { getCrawlStore } from "./crawl/crawlStore.js";
import { buildRagDocument, toJsonl } from "./knowledge/ragExport.js";
import { ingestSite } from "./knowledge/siteIngest.js";
import { ingestUrl, searchKnowledge } from "./knowledge/retrieval.js";
import { getVectorStore } from "./knowledge/vectorStore.js";
import { extractFromUrl } from "./extract/llmExtract.js";
import { extractFromSite, extractFromUrls } from "./extract/extractMulti.js";
import { createExtractionStore } from "./extract/extractionStore.js";
import { runRetention } from "./storage/retention.js";
import { getApprovalStore } from "./governance/approvalStore.js";
import { getAuditLog } from "./governance/auditLog.js";
import { applyApprovalDecision } from "./governance/approvalDecision.js";
import { createSnapshotStore } from "./storage/snapshotStore.js";
import { emitEvent } from "./events/eventBus.js";
import { runStalenessSweep } from "./schedule/scheduler.js";
import { getJobInfo } from "./queue/scrapeQueue.js";
import { readSitemap } from "./sitemap.js";
import type { ApprovalStatus, RenderMode, RetrievalMode, ScrapeAction } from "./types.js";

const program = new Command();

program.name("octopus-scout").description("Octoryn Web Ingestion Engine CLI").version("0.1.0");

program
  .command("fetch")
  .argument("<url>")
  .option("--timeout <ms>", "request timeout in milliseconds", parseInteger)
  .action(async (url, options) => {
    const result = await fetchResource(url, { timeoutMs: options.timeout });
    printJson({
      url: result.url,
      finalUrl: result.finalUrl,
      status: result.status,
      ok: result.ok,
      contentType: result.contentType,
      bytes: result.body.byteLength,
      elapsedMs: result.elapsedMs
    });
  });

program
  .command("render")
  .argument("<url>")
  .option("--timeout <ms>", "request timeout in milliseconds", parseInteger)
  .option("--wait-for <selector>", "wait for a CSS selector")
  .option("--screenshot", "include base64 PNG screenshot", false)
  .option("--actions <jsonFileOrInline>", "pre-capture browser actions: JSON array (file path or inline)")
  .action(async (url, options) => {
    const result = await renderResource(url, {
      timeoutMs: options.timeout,
      waitForSelector: options.waitFor,
      includeScreenshot: options.screenshot,
      actions: options.actions ? parseActionsOption(options.actions) : undefined
    });
    printJson({
      url: result.url,
      finalUrl: result.finalUrl,
      status: result.status,
      ok: result.ok,
      contentType: result.contentType,
      bytes: result.body.byteLength,
      elapsedMs: result.elapsedMs,
      screenshotBase64: result.screenshotBase64,
      actionScreenshots: result.actionScreenshots
    });
  });

program
  .command("scrape")
  .argument("<url>")
  .option("--render <mode>", "auto, static, or browser", "auto")
  .option("--timeout <ms>", "request timeout in milliseconds", parseInteger)
  .option("--wait-for <selector>", "wait for a CSS selector when rendering")
  .option("--force-refresh", "ignore fresh cache", false)
  .option("--include-html", "include fetched HTML in output", false)
  .option("--screenshot", "include browser screenshot when rendering", false)
  .option("--actions <jsonFileOrInline>", "pre-capture browser actions: JSON array (file path or inline)")
  .action(async (url, options) => {
    const result = await scrapeUrl({
      url,
      render: options.render as RenderMode,
      timeoutMs: options.timeout,
      waitForSelector: options.waitFor,
      forceRefresh: options.forceRefresh,
      includeHtml: options.includeHtml,
      includeScreenshot: options.screenshot,
      actions: options.actions ? parseActionsOption(options.actions) : undefined
    });
    printJson(result);
  });

program
  .command("sitemap")
  .argument("<url>")
  .option("--recursive", "follow sitemap index children", false)
  .option("--max-sitemaps <n>", "maximum sitemap files", parseInteger, 5)
  .action(async (url, options) => {
    printJson(await readSitemap(url, { recursive: options.recursive, maxSitemaps: options.maxSitemaps }));
  });

program
  .command("map")
  .argument("<url>")
  .description("fast site URL discovery (sitemap + root-page links)")
  .option("--limit <n>", "maximum URLs to return", parseInteger)
  .option("--search <text>", "case-insensitive substring filter on the full URL")
  .option("--include-subdomains", "include subdomains of the root host", false)
  .option("--no-sitemap", "do not consult the site sitemap")
  .option(
    "--include-path <substr>",
    "keep only URLs whose path+search contains substr (repeatable)",
    collectRepeatable,
    []
  )
  .option("--exclude-path <substr>", "drop URLs whose path+search contains substr (repeatable)", collectRepeatable, [])
  .action(async (url, options) => {
    const result = await mapSite({
      url,
      limit: options.limit,
      search: options.search,
      includeSubdomains: options.includeSubdomains,
      useSitemap: options.sitemap,
      includePaths: options.includePath,
      excludePaths: options.excludePath
    });
    for (const u of result.urls) {
      process.stdout.write(`${u}\n`);
    }
    process.stdout.write(`# ${result.count} urls (fromSitemap=${result.fromSitemap}, fromLinks=${result.fromLinks})\n`);
  });

program
  .command("crawl")
  .argument("<url>")
  .option("--max-depth <n>", "maximum crawl depth", parseInteger)
  .option("--max-pages <n>", "maximum pages to crawl", parseInteger)
  .option("--render <mode>", "auto, static, or browser", "auto")
  .option("--concurrency <n>", "concurrent page fetches", parseInteger)
  .option("--no-sitemap", "do not seed from sitemap")
  .option("--resume <crawlId>", "resume a previously checkpointed crawl")
  .action(async (url, options) => {
    const result = await crawl({
      url,
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
      render: options.render as RenderMode,
      concurrency: options.concurrency,
      useSitemap: options.sitemap,
      resumeCrawlId: options.resume
    });
    printJson(result);
  });

program
  .command("crawls")
  .description("list checkpointed/resumable crawl jobs")
  .option("--limit <n>", "maximum jobs to list (<=0 for all)", parseInteger)
  .action(async (options) => {
    const summaries = await getCrawlStore().list(options.limit);
    printJson(summaries);
  });

program
  .command("ingest-site")
  .argument("<url>")
  .option("--max-depth <n>", "maximum crawl depth", parseInteger)
  .option("--max-pages <n>", "maximum pages to crawl", parseInteger)
  .option("--render <mode>", "auto, static, or browser", "auto")
  .option("--concurrency <n>", "concurrent page fetches", parseInteger)
  .option("--max-tokens <n>", "maximum tokens per chunk", parseInteger)
  .option("--overlap-tokens <n>", "overlap tokens between chunks", parseInteger)
  .option("--same-origin-only", "restrict to the root origin")
  .option("--include-subdomains", "allow subdomains of the root host")
  .option("--no-sitemap", "do not seed from sitemap")
  .option("--summary", "print one line per page instead of full JSON", false)
  .action(async (url, options) => {
    const result = await ingestSite({
      url,
      maxDepth: options.maxDepth,
      maxPages: options.maxPages,
      render: options.render as RenderMode,
      concurrency: options.concurrency,
      maxTokens: options.maxTokens,
      overlapTokens: options.overlapTokens,
      sameOriginOnly: options.sameOriginOnly,
      includeSubdomains: options.includeSubdomains,
      useSitemap: options.sitemap
    });
    if (options.summary) {
      for (const page of result.pages) {
        const status = page.governanceStatus ? ` ${page.governanceStatus}` : "";
        const reason = page.reason ? ` (${page.reason})` : "";
        process.stdout.write(
          `${page.indexed ? "indexed" : "skipped"} ${page.chunks} chunks${status} ${page.url}${reason}\n`
        );
      }
    } else {
      printJson(result);
    }
  });

program
  .command("retention")
  .description("apply data-retention pruning (snapshots, audit, approvals)")
  .option("--snapshot-versions <n>", "keep at most N snapshot versions per url", parseInteger)
  .option("--snapshot-days <n>", "remove snapshots older than N days", parseInteger)
  .option("--audit-days <n>", "remove audit events/decided approvals older than N days", parseInteger)
  .action(async (options) => {
    const report = await runRetention({
      snapshotRetentionVersions: options.snapshotVersions,
      snapshotRetentionDays: options.snapshotDays,
      auditRetentionDays: options.auditDays
    });
    printJson(report);
  });

program
  .command("refresh")
  .description("re-ingest stale stored URLs (scheduled staleness sweep)")
  .option("--max-age-days <n>", "refresh snapshots older than N days", parseInteger)
  .option("--limit <n>", "maximum URLs to examine", parseInteger)
  .action(async (options) => {
    const result = await runStalenessSweep({
      maxAgeDays: options.maxAgeDays,
      limit: options.limit
    });
    printJson(result);
  });

program
  .command("export")
  .argument("<url>")
  .option("--embed", "compute embeddings for each chunk", false)
  .option("--max-tokens <n>", "maximum tokens per chunk", parseInteger)
  .option("--jsonl", "print JSONL (one line per chunk) instead of JSON", false)
  .action(async (url, options) => {
    const result = await scrapeUrl({ url });
    const doc = await buildRagDocument(result, {
      embed: options.embed,
      maxTokens: options.maxTokens
    });
    if (options.jsonl) {
      process.stdout.write(`${toJsonl(doc)}\n`);
    } else {
      printJson(doc);
    }
  });

program
  .command("ingest")
  .argument("<url>")
  .option("--max-tokens <n>", "maximum tokens per chunk", parseInteger)
  .option("--overlap-tokens <n>", "overlap tokens between chunks", parseInteger)
  .option("--force-refresh", "ignore fresh cache", false)
  .action(async (url, options) => {
    const result = await ingestUrl({
      url,
      maxTokens: options.maxTokens,
      overlapTokens: options.overlapTokens,
      forceRefresh: options.forceRefresh
    });
    printJson(result);
  });

program
  .command("search")
  .argument("<query>")
  .option("--top-k <n>", "number of hits to return", parseInteger)
  .option("--url <u>", "restrict to a source URL")
  .option("--min-trust <n>", "minimum trust score", Number.parseFloat)
  .option("--include-blocked", "include governance-blocked chunks", false)
  .option("--include-unapproved", "include chunks still pending approval (requires_approval)", false)
  .option("--mode <mode>", "retrieval mode: vector, lexical, or hybrid")
  .option("--rerank", "force second-stage reranking on")
  .option("--no-rerank", "disable second-stage reranking")
  .option("--rewrite", "expand the query into variants and fuse the results", false)
  .action(async (query, options) => {
    const result = await searchKnowledge({
      query,
      topK: options.topK,
      url: options.url,
      minTrust: options.minTrust,
      includeBlocked: options.includeBlocked,
      includeUnapproved: options.includeUnapproved,
      mode: options.mode as RetrievalMode | undefined,
      // commander sets options.rerank to false only when --no-rerank is passed
      // and true when --rerank is passed; otherwise it is undefined (use config).
      rerank: options.rerank,
      rewrite: options.rewrite
    });
    printJson(result);
  });

program
  .command("extract")
  .argument("<url>")
  .description("scrape a URL and extract structured data via an LLM provider")
  .requiredOption("--schema <jsonFileOrInline>", "JSON schema: path to a .json file or an inline JSON string")
  .option("--prompt <text>", "additional extraction instructions")
  .option("--force-refresh", "ignore fresh cache", false)
  .action(async (url, options) => {
    const schema = parseSchemaOption(options.schema);
    const result = await extractFromUrl({
      url,
      schema,
      prompt: options.prompt,
      forceRefresh: options.forceRefresh
    });
    printJson({
      data: result.data,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      skipped: result.skipped,
      reason: result.reason,
      governanceStatus: result.governanceStatus
    });
  });

program
  .command("extract-batch")
  .argument("<urls...>", "one or more URLs to extract from")
  .description("scrape multiple URLs and extract structured data via an LLM provider (one result per URL)")
  .requiredOption("--schema <jsonFileOrInline>", "JSON schema: path to a .json file or an inline JSON string")
  .option("--prompt <text>", "additional extraction instructions")
  .option("--force-refresh", "ignore fresh cache", false)
  .action(async (urls: string[], options) => {
    const schema = parseSchemaOption(options.schema);
    const results = await extractFromUrls({
      urls,
      schema,
      prompt: options.prompt,
      forceRefresh: options.forceRefresh
    });
    printJson(results);
  });

program
  .command("extract-site")
  .argument("<url>")
  .description("discover URLs across a site (fast map) then extract structured data from each via an LLM provider")
  .requiredOption("--schema <jsonFileOrInline>", "JSON schema: path to a .json file or an inline JSON string")
  .option("--prompt <text>", "additional extraction instructions")
  .option("--force-refresh", "ignore fresh cache", false)
  .option("--max-pages <n>", "maximum pages to discover and extract", parseInteger)
  .option("--max-depth <n>", "accepted for API symmetry (mapSite does not recurse)", parseInteger)
  .option("--include-subdomains", "include subdomains of the root host", false)
  .option("--search <text>", "case-insensitive substring filter on discovered URLs")
  .action(async (url, options) => {
    const schema = parseSchemaOption(options.schema);
    const result = await extractFromSite({
      url,
      schema,
      prompt: options.prompt,
      forceRefresh: options.forceRefresh,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      includeSubdomains: options.includeSubdomains,
      search: options.search
    });
    printJson(result);
  });

program
  .command("extractions")
  .description("list persisted structured extractions (secure-by-default: excludes non-allowed)")
  .option("--url <u>", "restrict to a source URL")
  .option("--include-unapproved", "include extractions still pending approval (requires_approval)", false)
  .option("--limit <n>", "maximum extractions to list (<=0 for all)", parseInteger)
  .action(async (options) => {
    const store = createExtractionStore();
    await store.init();
    const records = options.url
      ? await store.listByUrl(options.url, options.limit)
      : await store.list(options.limit, { includeUnapproved: options.includeUnapproved });
    printJson(records);
  });

program
  .command("job")
  .argument("<id>")
  .description("inspect a persistent queue job by id")
  .option("--queue <name>", "queue: scrape, crawl, site, or dead", "scrape")
  .action(async (id, options) => {
    const info = await getJobInfo(options.queue, id);
    if (!info) {
      process.stderr.write(`job ${id} not found in queue ${options.queue}\n`);
      process.exitCode = 1;
      return;
    }
    printJson(info);
  });

program
  .command("approvals")
  .argument("[status]", "pending, approved, or rejected")
  .action(async (status?: string) => {
    const records = await getApprovalStore().list(status as ApprovalStatus | undefined);
    printJson(records);
  });

program
  .command("approve")
  .argument("<id>")
  .requiredOption("--by <name>", "who is approving")
  .option("--note <text>", "decision note")
  .action(async (id, options) => {
    await decideApproval(id, "approved", options.by, options.note);
  });

program
  .command("reject")
  .argument("<id>")
  .requiredOption("--by <name>", "who is rejecting")
  .option("--note <text>", "decision note")
  .action(async (id, options) => {
    await decideApproval(id, "rejected", options.by, options.note);
  });

try {
  await program.parseAsync();
} finally {
  await browserPool.close();
}

async function decideApproval(
  id: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  note?: string
): Promise<void> {
  const record = await getApprovalStore().decide(id, decision, decidedBy, note);
  if (!record) {
    process.stderr.write(`approval ${id} not found\n`);
    process.exitCode = 1;
    return;
  }
  await getAuditLog().record({
    actor: decidedBy,
    action: "approval.decide",
    target: record.url,
    status: decision,
    detail: { approvalId: id, note }
  });
  // Make the decision have teeth on the durable layers: approve releases (or
  // re-indexes) the chunks; reject purges BOTH the index and the snapshot.
  // Mutation failures are audited and surfaced (never silently swallowed).
  const snapshotStore = createSnapshotStore();
  await snapshotStore.init();
  const effect = await applyApprovalDecision(record, decision, {
    vectorStore: getVectorStore(),
    snapshotStore,
    ingestUrl: (input) => ingestUrl(input),
    recordAudit: (event) => getAuditLog().record(event)
  });
  if (effect.error) {
    process.stderr.write(`warning: governance index/snapshot effect failed: ${effect.error}\n`);
    process.exitCode = 1;
  }
  try {
    emitEvent({
      type: "approval.decided",
      target: record.url,
      data: { approvalId: id, decision, decidedBy }
    });
  } catch {
    // best-effort
  }
  printJson(record);
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

/** Accumulate repeatable string options (e.g. --include-path a --include-path b). */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Resolve the --actions option into a ScrapeAction[]. The value may be an inline
 * JSON array string or a path to a .json file. Inline JSON (starting with "[")
 * is tried first; otherwise the value is treated as a file path. The parsed
 * value must be a JSON array; per-action validation happens downstream via the
 * scrapeActionSchema in the request pipeline.
 */
function parseActionsOption(value: string): ScrapeAction[] {
  const trimmed = value.trim();
  const raw = trimmed.startsWith("[") ? trimmed : readFileSync(value, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("actions must be a JSON array");
  }
  return parsed as ScrapeAction[];
}

/**
 * Resolve the --schema option into a JSON object. The value may be a path to a
 * JSON file or an inline JSON string. Inline JSON is tried first; if that fails
 * the value is treated as a file path and its contents are parsed.
 */
function parseSchemaOption(value: string): Record<string, unknown> {
  const tryParse = (raw: string): Record<string, unknown> => {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("schema must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  };

  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return tryParse(trimmed);
  }
  // Treat as a file path.
  return tryParse(readFileSync(value, "utf8"));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
