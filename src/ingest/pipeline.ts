import { loadConfig } from "../config.js";
import { buildEvidence } from "../evidence/evidenceBuilder.js";
import { canFetchUrl } from "../fetcher/robots.js";
import { getFetchProvider } from "../fetcher/fetchProvider.js";
import { extractResource } from "../extract/index.js";
import { createSnapshotStore } from "../storage/snapshotStore.js";
import { getAuditLog } from "../governance/auditLog.js";
import { getApprovalStore } from "../governance/approvalStore.js";
import { applyPolicy, policyTrustOverride } from "../governance/policy.js";
import type { ExtractionResult, RenderedResource, ScrapeRequest, ScrapeResult } from "../types.js";
import { normalizeUrl } from "../utils/url.js";
import { recordDedupHit, recordGovernance as recordGovernanceMetric } from "../metrics.js";
import { emitEvent } from "../events/eventBus.js";
import { scrapeRequestSchema } from "./schema.js";

const store = createSnapshotStore();

export async function scrapeUrl(input: ScrapeRequest): Promise<ScrapeResult> {
  const config = loadConfig();
  const request = scrapeRequestSchema.parse({
    render: "auto",
    respectRobots: true,
    forceRefresh: false,
    includeHtml: false,
    includeScreenshot: false,
    ...input,
    url: normalizeUrl(input.url)
  });

  await store.init();

  if (!request.forceRefresh && config.cacheTtlSeconds > 0) {
    const cached = await store.getFreshByUrl(request.url, config.cacheTtlSeconds);
    if (cached && isCacheCompatible(cached.result.request, request)) {
      return {
        ...cached.result,
        request,
        cache: {
          hit: true,
          snapshotId: cached.id
        }
      };
    }
  }

  const robots = await canFetchUrl(request.url, request.respectRobots);
  if (!robots.allowed) {
    throw Object.assign(new Error(robots.reason), { statusCode: 451, robots });
  }

  const fetchResult = await getFetchProvider().fetch(request.url, {
    render: request.render,
    timeoutMs: request.timeoutMs,
    waitForSelector: request.waitForSelector,
    includeScreenshot: request.includeScreenshot,
    actions: request.actions
  });
  const resource = fetchResult.resource;
  const rendered = fetchResult.rendered;

  const extraction = await extractResource(resource);
  const evidence = buildEvidence({
    sourceUrl: request.url,
    finalUrl: resource.finalUrl,
    extraction,
    robotsAllowed: robots.allowed
  });

  // Per-domain governance policy escalates (never relaxes) the base decision.
  evidence.governance = applyPolicy(request.url, evidence.governance);
  recordGovernanceMetric(evidence.governance.status);
  const trustOverride = policyTrustOverride(request.url);
  if (trustOverride !== undefined) {
    evidence.trust = {
      ...evidence.trust,
      score: trustOverride,
      label: trustOverride >= 0.75 ? "high" : trustOverride >= 0.45 ? "medium" : "low",
      reasons: [...evidence.trust.reasons, "domain policy trust override"]
    };
  }

  const blocked = evidence.governance.status === "blocked";

  // BLOCK MEANS BLOCK: blocked content must never be persisted or served. We
  // drop the body, extracted text/markdown, and any screenshots so nothing
  // sensitive leaks through the response, and we skip the snapshot store below.
  const result: ScrapeResult = {
    request,
    fetch: {
      url: resource.url,
      finalUrl: resource.finalUrl,
      status: resource.status,
      ok: resource.ok,
      contentType: resource.contentType,
      fetchedAt: resource.fetchedAt,
      elapsedMs: resource.elapsedMs,
      rendered,
      html:
        !blocked && request.includeHtml && resource.contentType.includes("html")
          ? resource.body.toString("utf8")
          : undefined,
      screenshotBase64: blocked ? undefined : (resource as Partial<RenderedResource>).screenshotBase64,
      actionScreenshots: blocked ? undefined : (resource as Partial<RenderedResource>).actionScreenshots
    },
    extraction: blocked ? blankExtraction(extraction) : extraction,
    evidence,
    cache: {
      hit: false
    }
  };

  const contentHash = result.evidence.contentHash;

  if (blocked) {
    // Audit the block (as today) but never save a snapshot or serve the body.
    await recordGovernance(result, undefined, contentHash, false, config.approvalMode);
    try {
      emitEvent({
        type: "scrape.completed",
        target: request.url,
        data: { snapshotId: undefined, contentHash, governanceStatus: "blocked", duplicate: false }
      });
    } catch {
      // never let eventing break a scrape
    }
    return result;
  }

  let finalResult: ScrapeResult;
  let snapshotId: string | undefined;
  let dedupDuplicate = false;

  const existing = !request.forceRefresh ? await store.findByHash(request.url, contentHash) : undefined;
  if (existing) {
    dedupDuplicate = true;
    recordDedupHit();
    snapshotId = existing.id;
    finalResult = {
      ...result,
      cache: {
        hit: false,
        snapshotId: existing.id,
        dedup: { duplicate: true, ofSnapshotId: existing.id }
      }
    };
  } else {
    const snapshot = await store.save(result);
    snapshotId = snapshot.id;
    finalResult = {
      ...result,
      cache: {
        hit: false,
        snapshotId: snapshot.id,
        dedup: { duplicate: false }
      }
    };
  }

  await recordGovernance(finalResult, snapshotId, contentHash, dedupDuplicate, config.approvalMode);

  // Best-effort event emission; emitEvent never throws but wrap defensively so
  // event work can never break the core pipeline.
  try {
    emitEvent({
      type: "scrape.completed",
      target: request.url,
      data: {
        snapshotId,
        contentHash,
        governanceStatus: finalResult.evidence.governance.status,
        duplicate: dedupDuplicate
      }
    });
  } catch {
    // never let eventing break a scrape
  }

  return finalResult;
}

async function recordGovernance(
  result: ScrapeResult,
  snapshotId: string | undefined,
  contentHash: string,
  dedupDuplicate: boolean,
  approvalMode: ReturnType<typeof loadConfig>["approvalMode"]
): Promise<void> {
  const governance = result.evidence.governance;
  try {
    await getAuditLog().record({
      actor: "system",
      action: "scrape",
      target: result.request.url,
      status: governance.status,
      policyVersion: governance.policyVersion,
      detail: { snapshotId, contentHash, dedup: result.cache.dedup }
    });

    if (governance.status === "requires_approval" && approvalMode !== "off" && !dedupDuplicate) {
      const rec = await getApprovalStore().create({
        url: result.request.url,
        snapshotId,
        contentHash,
        reasons: governance.reasons
      });
      await getAuditLog().record({
        actor: "system",
        action: "approval_requested",
        target: result.request.url,
        status: "pending",
        policyVersion: governance.policyVersion,
        detail: { approvalId: rec.id }
      });
      try {
        emitEvent({
          type: "approval.requested",
          target: result.request.url,
          data: { approvalId: rec.id, reasons: governance.reasons }
        });
      } catch {
        // best-effort
      }
    }
  } catch {
    // Governance stores degrade gracefully; never block a scrape on audit/approval failures.
  }
}

/**
 * Strip the body content from an extraction for a blocked source, keeping only
 * lightweight metadata (kind/title/etc.). Blocked content must never be served,
 * so the text/markdown/links/images/tables are emptied.
 */
function blankExtraction(extraction: ExtractionResult): ExtractionResult {
  return {
    ...extraction,
    textContent: "",
    markdown: "",
    links: [],
    images: [],
    tables: []
  };
}

function isCacheCompatible(cached: ScrapeResult["request"], request: ScrapeResult["request"]): boolean {
  return (
    cached.render === request.render &&
    cached.waitForSelector === request.waitForSelector &&
    cached.includeHtml === request.includeHtml &&
    cached.includeScreenshot === request.includeScreenshot
  );
}
