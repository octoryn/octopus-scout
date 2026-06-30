import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The governance stores resolve their backend via loadConfig() at first use and
// then cache the instance for the lifetime of the module. To exercise the
// file-backed implementation hermetically we point OCTORYN_SCOUT_DATA_DIR at a
// unique temp directory and ensure DATABASE_URL is unset BEFORE importing the
// modules, so getApprovalStore()/getAuditLog() construct the File* backends.

let dataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

type ApprovalStoreModule = typeof import("../src/governance/approvalStore.js");
type AuditLogModule = typeof import("../src/governance/auditLog.js");

let approvalStoreModule: ApprovalStoreModule;
let auditLogModule: AuditLogModule;

beforeAll(async () => {
  savedDataDir = process.env.OCTORYN_SCOUT_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;

  dataDir = await mkdtemp(join(tmpdir(), `octopus-gov-${randomUUID()}-`));
  process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;

  // Import after env is configured so the module-level cache binds to the
  // file-backed store rooted at our temp directory.
  approvalStoreModule = await import("../src/governance/approvalStore.js");
  auditLogModule = await import("../src/governance/auditLog.js");
});

afterAll(async () => {
  if (savedDataDir === undefined) {
    delete process.env.OCTORYN_SCOUT_DATA_DIR;
  } else {
    process.env.OCTORYN_SCOUT_DATA_DIR = savedDataDir;
  }
  if (savedDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = savedDatabaseUrl;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe("file-backed ApprovalStore", () => {
  it("creates a pending record that surfaces in list and get", async () => {
    const store = approvalStoreModule.getApprovalStore();

    const created = await store.create({
      url: "https://example.com/page",
      contentHash: "hash-abc",
      reasons: ["new domain"]
    });

    expect(created.id).toBeTruthy();
    expect(created.status).toBe("pending");
    expect(created.url).toBe("https://example.com/page");
    expect(created.contentHash).toBe("hash-abc");
    expect(created.reasons).toEqual(["new domain"]);
    expect(created.createdAt).toBeTruthy();
    expect(created.decidedAt).toBeUndefined();
    expect(created.decidedBy).toBeUndefined();

    const pending = await store.list("pending");
    expect(pending.some((r) => r.id === created.id)).toBe(true);

    const fetched = await store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.status).toBe("pending");
  });

  it("approves a record and records decidedBy/decidedAt", async () => {
    const store = approvalStoreModule.getApprovalStore();

    const created = await store.create({
      url: "https://example.com/approve",
      snapshotId: "snap-1",
      contentHash: "hash-approve",
      reasons: ["manual review"]
    });

    const decided = await store.decide(created.id, "approved", "alice", "looks good");
    expect(decided).toBeDefined();
    expect(decided?.status).toBe("approved");
    expect(decided?.decidedBy).toBe("alice");
    expect(decided?.note).toBe("looks good");
    expect(decided?.decidedAt).toBeTruthy();

    // get() reflects the decision.
    const fetched = await store.get(created.id);
    expect(fetched?.status).toBe("approved");
    expect(fetched?.decidedBy).toBe("alice");
    expect(fetched?.decidedAt).toBe(decided?.decidedAt);

    // It is no longer in the pending list...
    const pending = await store.list("pending");
    expect(pending.some((r) => r.id === created.id)).toBe(false);

    // ...but appears under the approved filter.
    const approved = await store.list("approved");
    expect(approved.some((r) => r.id === created.id)).toBe(true);
  });

  it("rejects a record and records decidedBy/decidedAt", async () => {
    const store = approvalStoreModule.getApprovalStore();

    const created = await store.create({
      url: "https://example.com/reject",
      contentHash: "hash-reject",
      reasons: ["blocklisted"]
    });

    const decided = await store.decide(created.id, "rejected", "bob");
    expect(decided?.status).toBe("rejected");
    expect(decided?.decidedBy).toBe("bob");
    expect(decided?.decidedAt).toBeTruthy();

    const fetched = await store.get(created.id);
    expect(fetched?.status).toBe("rejected");
    expect(fetched?.decidedBy).toBe("bob");

    const rejected = await store.list("rejected");
    expect(rejected.some((r) => r.id === created.id)).toBe(true);
  });

  it("returns undefined when deciding a non-existent record", async () => {
    const store = approvalStoreModule.getApprovalStore();
    const result = await store.decide(randomUUID(), "approved", "carol");
    expect(result).toBeUndefined();
  });
});

describe("approval decisions have teeth on the vector index", () => {
  // The decision handler (server.ts / cli.ts) calls into the vector store to
  // release (approve) or purge (reject) a source's chunks. Exercise that
  // contract directly against the file-backed store.
  type StoredChunk = import("../src/types.js").StoredChunk;

  function chunk(id: string, sourceUrl: string, status: StoredChunk["governanceStatus"]): StoredChunk {
    return {
      chunkId: id,
      documentId: `doc-${id}`,
      sourceUrl,
      finalUrl: sourceUrl,
      title: "Doc",
      contentHash: `hash-${id}`,
      index: 0,
      content: `content ${id}`,
      headingPath: [],
      governanceStatus: status,
      trustScore: 0.9,
      capturedAt: "2026-06-30T00:00:00.000Z",
      embedding: [1, 0, 0]
    };
  }

  it("APPROVE releases requires_approval chunks so they become searchable", async () => {
    const { getVectorStore } = await import("../src/knowledge/vectorStore.js");
    const store = getVectorStore();
    await store.init();
    const url = `https://example.com/approve-${randomUUID()}`;
    await store.upsertChunks([chunk(randomUUID(), url, "requires_approval")]);

    // Hidden by default while pending.
    expect((await store.search([1, 0, 0], 10, { url })).length).toBe(0);

    // Approve == set status allowed for the url.
    const updated = await store.setGovernanceStatusByUrl(url, "allowed");
    expect(updated).toBe(1);

    // Now searchable by default.
    expect((await store.search([1, 0, 0], 10, { url })).length).toBe(1);
  });

  it("REJECT purges the indexed chunks for the url", async () => {
    const { getVectorStore } = await import("../src/knowledge/vectorStore.js");
    const store = getVectorStore();
    await store.init();
    const url = `https://example.com/reject-${randomUUID()}`;
    await store.upsertChunks([chunk(randomUUID(), url, "requires_approval")]);

    // Reject == purge from the index entirely.
    await store.deleteByUrl(url);

    // Gone even with the most permissive filter.
    const hits = await store.search([1, 0, 0], 10, { url, includeBlocked: true, includeUnapproved: true });
    expect(hits.length).toBe(0);
  });
});

describe("file-backed AuditLog", () => {
  it("records an event and lists it filtered by target", async () => {
    const log = auditLogModule.getAuditLog();
    const target = `https://example.com/${randomUUID()}`;

    const recorded = await log.record({
      actor: "alice",
      action: "approve",
      target,
      status: "ok"
    });

    expect(recorded.id).toBeTruthy();
    expect(recorded.at).toBeTruthy();
    expect(recorded.target).toBe(target);

    const byTarget = await log.list({ target });
    expect(byTarget).toHaveLength(1);
    expect(byTarget[0].id).toBe(recorded.id);
    expect(byTarget[0].action).toBe("approve");
  });

  it("filters listed events by action", async () => {
    const log = auditLogModule.getAuditLog();
    const action = `action-${randomUUID()}`;

    const a = await log.record({ actor: "x", action, target: "t1", status: "ok" });
    const b = await log.record({ actor: "y", action, target: "t2", status: "ok" });
    // Different action that must not match.
    await log.record({ actor: "z", action: `other-${randomUUID()}`, target: "t3", status: "ok" });

    const matched = await log.list({ action });
    const ids = matched.map((e) => e.id);
    expect(matched).toHaveLength(2);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("combines target and action filters", async () => {
    const log = auditLogModule.getAuditLog();
    const action = `combo-${randomUUID()}`;
    const target = `target-${randomUUID()}`;

    const hit = await log.record({ actor: "x", action, target, status: "ok" });
    await log.record({ actor: "x", action, target: "different-target", status: "ok" });

    const matched = await log.list({ target, action });
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe(hit.id);
  });
});

describe("shared applyApprovalDecision", () => {
  type Mod = typeof import("../src/governance/approvalDecision.js");
  type SnapMod = typeof import("../src/storage/snapshotStore.js");
  type ApprovalRecord = import("../src/types.js").ApprovalRecord;
  let mod: Mod;
  let snapMod: SnapMod;

  beforeAll(async () => {
    mod = await import("../src/governance/approvalDecision.js");
    snapMod = await import("../src/storage/snapshotStore.js");
  });

  function record(url: string, status: "approved" | "rejected"): ApprovalRecord {
    return {
      id: randomUUID(),
      url,
      contentHash: "hash-x",
      status,
      reasons: ["test"],
      createdAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      decidedBy: "alice"
    } as never;
  }

  function makeResult(url: string, status: "allowed" | "blocked" | "requires_approval") {
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
        rendered: false
      },
      extraction: {
        kind: "html",
        title: "t",
        textContent: "x",
        markdown: "x",
        links: [],
        images: [],
        tables: [],
        metadata: {}
      },
      evidence: {
        sourceUrl: url,
        finalUrl: url,
        capturedAt: new Date().toISOString(),
        contentHash: "hash-x",
        anchors: [],
        trust: { score: 0.5, label: "medium", reasons: [] },
        governance: { status, reasons: [], policyVersion: "test" }
      },
      cache: { hit: false }
    } as never;
  }

  it("approve releases already-indexed chunks to allowed (no re-ingest)", async () => {
    const url = "https://example.com/approve-release";
    let setStatusArgs: [string, string] | undefined;
    let ingested = false;
    const audits: { action: string; status: string }[] = [];

    const result = await mod.applyApprovalDecision(record(url, "approved"), "approved", {
      vectorStore: {
        init: async () => {},
        setGovernanceStatusByUrl: async (u, s) => {
          setStatusArgs = [u, s];
          return 3; // chunks already indexed
        },
        deleteByUrl: async () => {}
      },
      snapshotStore: { deleteByUrl: async () => 0 },
      ingestUrl: async () => {
        ingested = true;
        return {
          documentId: "d",
          sourceUrl: url,
          finalUrl: url,
          contentHash: "h",
          chunksIndexed: 0,
          governanceStatus: "allowed"
        };
      },
      recordAudit: async (e) => {
        audits.push({ action: e.action, status: e.status });
        return undefined;
      }
    });

    expect(setStatusArgs).toEqual([url, "allowed"]);
    expect(ingested).toBe(false);
    expect(result.released).toBe(3);
    expect(result.error).toBeUndefined();
    expect(audits.some((a) => a.action === "index.release")).toBe(true);
  });

  it("approve re-ingests when nothing was indexed (enforce-mode quarantine)", async () => {
    const url = "https://example.com/approve-reingest";
    let ingested = false;
    const result = await mod.applyApprovalDecision(record(url, "approved"), "approved", {
      vectorStore: {
        init: async () => {},
        setGovernanceStatusByUrl: async () => 0, // never indexed
        deleteByUrl: async () => {}
      },
      snapshotStore: { deleteByUrl: async () => 0 },
      ingestUrl: async () => {
        ingested = true;
        return {
          documentId: "d",
          sourceUrl: url,
          finalUrl: url,
          contentHash: "h",
          chunksIndexed: 5,
          governanceStatus: "allowed"
        };
      },
      recordAudit: async () => undefined
    });

    expect(ingested).toBe(true);
    expect(result.reingested).toBe(5);
    expect(result.released).toBe(5);
  });

  it("reject purges BOTH the vector index and the persisted snapshot", async () => {
    // Use a real file-backed snapshot store seeded with a snapshot for this url.
    const url = `https://example.com/reject-${randomUUID()}`;
    const store = snapMod.createSnapshotStore();
    await store.init();
    await store.save(makeResult(url, "requires_approval"));
    // Sanity: the snapshot is initially served.
    expect(await store.getLatestByUrl(url)).toBeDefined();

    let vectorDeleted: string | undefined;
    const audits: string[] = [];
    const result = await mod.applyApprovalDecision(record(url, "rejected"), "rejected", {
      vectorStore: {
        init: async () => {},
        setGovernanceStatusByUrl: async () => 0,
        deleteByUrl: async (u) => {
          vectorDeleted = u;
        }
      },
      snapshotStore: store,
      ingestUrl: async () => {
        throw new Error("should not ingest on reject");
      },
      recordAudit: async (e) => {
        audits.push(e.action);
        return undefined;
      }
    });

    expect(result.purged).toBe(true);
    expect(vectorDeleted).toBe(url);
    expect(audits).toContain("index.purge");
    // The persisted snapshot is gone — /snapshots can no longer serve it.
    expect(await store.getLatestByUrl(url)).toBeUndefined();
    expect(await store.listVersionsByUrl(url)).toEqual([]);
  });

  it("records an index.mutation_failed audit and returns the error when a store throws", async () => {
    const url = "https://example.com/mutation-fail";
    const audits: { action: string; detail?: Record<string, unknown> }[] = [];
    const result = await mod.applyApprovalDecision(record(url, "approved"), "approved", {
      vectorStore: {
        init: async () => {},
        setGovernanceStatusByUrl: async () => {
          throw new Error("vector store down");
        },
        deleteByUrl: async () => {}
      },
      snapshotStore: { deleteByUrl: async () => 0 },
      ingestUrl: async () => {
        throw new Error("nope");
      },
      recordAudit: async (e) => {
        audits.push({ action: e.action, detail: e.detail });
        return undefined;
      }
    });

    expect(result.error).toContain("vector store down");
    const failure = audits.find((a) => a.action === "index.mutation_failed");
    expect(failure).toBeDefined();
    expect(String(failure?.detail?.error)).toContain("vector store down");
  });
});
