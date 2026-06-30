import { loadConfig } from "../config.js";
import { createSnapshotStore } from "../storage/snapshotStore.js";
import { getAuditLog } from "../governance/auditLog.js";
import { getApprovalStore } from "../governance/approvalStore.js";
import { getVectorStore } from "../knowledge/vectorStore.js";
import type { RetentionReport, SnapshotSummary } from "../types.js";

export interface RetentionOptions {
  snapshotRetentionVersions?: number;
  snapshotRetentionDays?: number;
  auditRetentionDays?: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Compute which snapshot ids for a single url should be removed, given the
 * configured retention policy. The newest version is always kept.
 *
 * `versions` is expected to be the output of `listVersionsByUrl`. We sort it
 * defensively (newest first) rather than trusting the store's ordering so the
 * "keep newest N" / "keep at least 1" guarantees hold regardless of backend.
 */
function selectExpiredSnapshots(
  versions: SnapshotSummary[],
  keepVersions: number,
  maxAgeMs: number,
  now: number
): string[] {
  if (versions.length <= 1) {
    return [];
  }
  const sorted = [...versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const removeIds: string[] = [];
  // Index 0 is always kept (newest). Evaluate the rest.
  for (let i = 1; i < sorted.length; i += 1) {
    const entry = sorted[i];
    let remove = false;
    if (keepVersions > 0 && i >= keepVersions) {
      remove = true;
    }
    if (!remove && maxAgeMs > 0) {
      const createdMs = Date.parse(entry.createdAt);
      if (Number.isFinite(createdMs) && now - createdMs > maxAgeMs) {
        remove = true;
      }
    }
    if (remove) {
      removeIds.push(entry.id);
    }
  }
  return removeIds;
}

/**
 * Apply data-retention policy across snapshots, audit events, and approvals.
 *
 * Each prune target is best-effort: a failure in one (e.g. no pg/redis, or a
 * single delete error) is swallowed so the remaining targets still run. A
 * value of 0 for any retention setting means "keep everything" and that target
 * is skipped entirely. The newest snapshot per url is always preserved.
 */
export async function runRetention(opts?: RetentionOptions): Promise<RetentionReport> {
  const config = loadConfig();
  const keepVersions = opts?.snapshotRetentionVersions ?? config.snapshotRetentionVersions;
  const snapshotDays = opts?.snapshotRetentionDays ?? config.snapshotRetentionDays;
  const auditDays = opts?.auditRetentionDays ?? config.auditRetentionDays;

  const now = Date.now();
  let snapshotsRemoved = 0;
  let auditEventsRemoved = 0;
  let approvalsRemoved = 0;

  // URLs for which retention removed every remaining snapshot version. Their
  // indexed vector chunks would otherwise be orphaned, so we purge them below.
  const fullyEvictedUrls = new Set<string>();

  // --- Snapshots -----------------------------------------------------------
  if (keepVersions > 0 || snapshotDays > 0) {
    const snapshotMaxAgeMs = snapshotDays > 0 ? snapshotDays * MS_PER_DAY : 0;
    try {
      const store = createSnapshotStore();
      await store.init();
      let urls: string[] = [];
      try {
        urls = await store.listUrls();
      } catch {
        urls = [];
      }
      for (const url of urls) {
        try {
          const versions = await store.listVersionsByUrl(url);
          const expired = selectExpiredSnapshots(versions, keepVersions, snapshotMaxAgeMs, now);
          let removedForUrl = 0;
          for (const id of expired) {
            try {
              const removed = await store.deleteById(id);
              if (removed) {
                snapshotsRemoved += 1;
                removedForUrl += 1;
              }
            } catch {
              // Best-effort: skip this snapshot and continue.
            }
          }
          // If nothing survives for this url, mark its vectors for purge.
          if (removedForUrl > 0) {
            try {
              const remaining = await store.listVersionsByUrl(url);
              if (remaining.length === 0) {
                fullyEvictedUrls.add(url);
              }
            } catch {
              // Best-effort: skip the remaining-check for this url.
            }
          }
        } catch {
          // Best-effort: skip this url and continue.
        }
      }
    } catch {
      // Store unavailable (no pg, fs error, etc.) — skip snapshot pruning.
    }
  }

  // --- Orphaned vectors ----------------------------------------------------
  // Purge indexed chunks for any url whose snapshots were entirely removed, so
  // retention never leaves orphaned RAG chunks behind. Best-effort per url.
  if (fullyEvictedUrls.size > 0) {
    try {
      const vectorStore = getVectorStore();
      await vectorStore.init();
      for (const url of fullyEvictedUrls) {
        try {
          await vectorStore.deleteByUrl(url);
        } catch {
          // Best-effort: skip this url and continue.
        }
      }
    } catch {
      // Vector store unavailable — skip vector pruning.
    }
  }

  // --- Audit events --------------------------------------------------------
  if (auditDays > 0) {
    const maxAgeMs = auditDays * MS_PER_DAY;
    try {
      auditEventsRemoved = await getAuditLog().prune({ maxAgeMs });
    } catch {
      // Best-effort: leave count at 0.
    }
  }

  // --- Approvals (reuse the audit horizon; only prune decided records) -----
  if (auditDays > 0) {
    const maxAgeMs = auditDays * MS_PER_DAY;
    try {
      approvalsRemoved = await getApprovalStore().prune({ maxAgeMs, onlyDecided: true });
    } catch {
      // Best-effort: leave count at 0.
    }
  }

  return {
    snapshotsRemoved,
    auditEventsRemoved,
    approvalsRemoved,
    ranAt: new Date().toISOString()
  };
}
