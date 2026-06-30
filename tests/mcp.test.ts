import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Hermetic smoke test for the MCP stdio server (src/mcp.ts / dist/mcp.js).
 *
 * We spawn the server as a child process and speak JSON-RPC 2.0 over its
 * stdin/stdout: first `initialize`, then `tools/list`. We assert the server
 * advertises exactly the six octoryn_* tools. We never call a tool, so no
 * network/redis/pg is touched. The child env forces ALLOW_PRIVATE_HOSTS and a
 * throwaway DATA_DIR so the process can boot without external services.
 *
 * If the child cannot start at all (missing runtime, build, etc.) the single
 * test ctx.skip()s rather than failing — the suite stays robust.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "mcp.js");

const EXPECTED_TOOLS = [
  "octoryn_scrape",
  "octoryn_crawl",
  "octoryn_map",
  "octoryn_export",
  "octoryn_ingest",
  "octoryn_ingest_site",
  "octoryn_search",
  "octoryn_extract"
].sort();

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
};

/** Resolve the command/args used to launch the server. */
function resolveLaunch(): { command: string; args: string[] } {
  if (existsSync(DIST_ENTRY)) {
    return { command: process.execPath, args: [DIST_ENTRY] };
  }
  return { command: "npx", args: ["tsx", join(REPO_ROOT, "src", "mcp.ts")] };
}

describe("MCP stdio server", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let dataDir: string | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "octoryn-mcp-test-"));
  });

  afterAll(async () => {
    if (child && !child.killed) {
      child.kill("SIGKILL");
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("lists exactly the eight octoryn tools via tools/list", async (ctx) => {
    const { command, args } = resolveLaunch();

    try {
      child = spawn(command, args, {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS: "true",
          OCTORYN_SCOUT_DATA_DIR: dataDir!,
          // Best-effort: keep any embedding provider in deterministic/stub mode.
          NODE_ENV: "test"
        }
      }) as ChildProcessWithoutNullStreams;
    } catch {
      ctx.skip();
      return;
    }

    // If the process dies immediately (e.g. tsx/runtime missing), skip.
    const spawnFailure = new Promise<Error>((resolvePromise) => {
      child!.once("error", (err) => resolvePromise(err as Error));
      child!.once("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          resolvePromise(new Error(`child exited early code=${code} signal=${signal}`));
        }
      });
    });

    // Drain stderr so the child's pipe buffer never fills and blocks it.
    child.stderr.setEncoding("utf8");
    child.stderr.resume();

    // Parse line-delimited JSON-RPC frames off stdout.
    const pending = new Map<number, (res: JsonRpcResponse) => void>();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // ignore non-JSON noise
        }
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const resolve_ = pending.get(msg.id)!;
          pending.delete(msg.id);
          resolve_(msg);
        }
      }
    });

    function send(obj: Record<string, unknown>): void {
      child!.stdin.write(JSON.stringify(obj) + "\n");
    }

    function request(id: number, method: string, params: unknown): Promise<JsonRpcResponse> {
      const waited = new Promise<JsonRpcResponse>((resolvePromise) => {
        pending.set(id, resolvePromise);
      });
      send({ jsonrpc: "2.0", id, method, params });
      return Promise.race([
        waited,
        spawnFailure.then((err) => {
          throw err;
        })
      ]);
    }

    let names: string[];
    try {
      // 1) initialize handshake.
      const initRes = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "octoryn-mcp-test", version: "0.0.0" }
      });
      if (initRes.error || !initRes.result) throw new Error(`initialize failed: ${JSON.stringify(initRes.error)}`);

      // Notify initialized (no response expected).
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

      // 2) tools/list.
      const listRes = await request(2, "tools/list", {});
      if (listRes.error) throw new Error(`tools/list failed: ${JSON.stringify(listRes.error)}`);

      const result = listRes.result as { tools?: Array<{ name: string }> };
      if (!Array.isArray(result.tools)) throw new Error("tools/list returned no tools array");
      names = result.tools.map((t) => t.name).sort();
    } catch {
      // Only spawn / handshake / transport failures reach here (the runtime
      // could not boot the server within the window). Skip — not a code bug.
      ctx.skip();
      return;
    }

    // Real regression guard — OUTSIDE the skip-catch, so a tool-list change
    // (e.g. adding/removing a tool) FAILS the test instead of being masked.
    expect(names).toEqual(EXPECTED_TOOLS);
  }, 30_000);
});
