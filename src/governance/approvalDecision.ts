import type { ApprovalRecord, IngestResult } from "../types.js";

/**
 * Minimal contracts for the downstream stores/effects an approval decision
 * touches. Taken as deps so this module is unit-testable without booting the
 * real vector store, snapshot store, or audit log.
 */
export interface ApprovalDecisionDeps {
  vectorStore: {
    init(): Promise<void>;
    setGovernanceStatusByUrl(url: string, status: "allowed" | "blocked" | "requires_approval"): Promise<number>;
    deleteByUrl(url: string): Promise<void>;
  };
  snapshotStore: {
    deleteByUrl(url: string): Promise<number>;
  };
  ingestUrl: (input: { url: string }) => Promise<IngestResult>;
  recordAudit: (event: {
    actor: string;
    action: string;
    target: string;
    status: string;
    detail?: Record<string, unknown>;
  }) => Promise<unknown>;
}

/** Outcome of applying a decision to the index/snapshot layer. */
export interface ApprovalDecisionResult {
  released?: number;
  reingested?: number;
  purged?: boolean;
  error?: string;
}

/**
 * Apply a human approval decision to the durable layers (vector index +
 * persisted snapshots). This is the downstream effect of an approval decision;
 * the approval-record write itself stays at the call site.
 *
 * APPROVE: release the source's chunks to "allowed". If nothing was indexed
 * (enforce-mode quarantine never wrote chunks), ingest the now-approved content
 * so it becomes searchable. Audited as action "index.release".
 *
 * REJECT: purge BOTH the vector index AND the persisted snapshot for the url so
 * the content can no longer leak via search or /snapshots. Audited as action
 * "index.purge".
 *
 * Error handling: index/snapshot mutation failures are caught, logged via
 * console.error, AND recorded as an audit event "index.mutation_failed" with the
 * error message, then surfaced in the returned result.error so the caller can
 * report it. The approval-record write (at the call site) has already succeeded
 * and is never rolled back here.
 */
export async function applyApprovalDecision(
  record: ApprovalRecord,
  status: "approved" | "rejected",
  deps: ApprovalDecisionDeps
): Promise<ApprovalDecisionResult> {
  const { vectorStore, snapshotStore, ingestUrl, recordAudit } = deps;
  const url = record.url;
  const actor = record.decidedBy ?? "system";

  try {
    await vectorStore.init();
    if (status === "approved") {
      let released = await vectorStore.setGovernanceStatusByUrl(url, "allowed");
      let reingested: number | undefined;
      // Never indexed (enforce-mode quarantine) — index the now-approved content.
      if (released === 0) {
        const ingest = await ingestUrl({ url });
        reingested = ingest.chunksIndexed;
        released = ingest.chunksIndexed;
      }
      await recordAudit({
        actor,
        action: "index.release",
        target: url,
        status: "allowed",
        detail: { released, reingested }
      });
      return reingested === undefined ? { released } : { released, reingested };
    }

    // Rejected: purge both the index and the persisted snapshot.
    await vectorStore.deleteByUrl(url);
    const purgedSnapshots = await snapshotStore.deleteByUrl(url);
    await recordAudit({
      actor,
      action: "index.purge",
      target: url,
      status: "rejected",
      detail: { purgedSnapshots }
    });
    return { purged: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface the failure: log it, audit it, and return it. The decision write
    // already succeeded at the call site, but the downstream effect did not.
    console.error(`applyApprovalDecision(${status}) failed for ${url}: ${message}`);
    try {
      await recordAudit({
        actor,
        action: "index.mutation_failed",
        target: url,
        status,
        detail: { error: message }
      });
    } catch {
      // The audit sink itself is unavailable — nothing more we can safely do.
    }
    return { error: message };
  }
}
