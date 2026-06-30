import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { renderResource, browserPool } from "../src/browser/browserPool.js";

/**
 * GATED browser test for pre-capture {@link renderResource} actions.
 *
 * Serves a tiny localhost page (node:http on 127.0.0.1) with a button that,
 * when clicked, reveals text inside a #result div. We then drive the page
 * through a waitForSelector -> click -> waitForSelector -> screenshot action
 * chain and assert the returned page content reflects the click and that one
 * action screenshot was captured.
 *
 * This test is GATED: Playwright's chromium may not be installed in the
 * environment, and binding a socket can occasionally fail. In either case the
 * test skips gracefully (ctx.skip()) rather than failing.
 */

const REVEALED_TEXT = "octopus-scout-revealed-payload";

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>actions</title></head>
  <body>
    <button id="btn" onclick="document.getElementById('result').textContent='${REVEALED_TEXT}'">Reveal</button>
    <div id="result"></div>
  </body>
</html>`;

let server: http.Server | undefined;
let origin: string | undefined;

const ORIGINAL_ENV = { ...process.env };

/** Start the localhost fixture server. Returns false if the socket can't bind. */
async function startServer(): Promise<boolean> {
  try {
    const s = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = s.address() as AddressInfo;
    server = s;
    origin = `http://127.0.0.1:${addr.port}`;
    return true;
  } catch {
    return false;
  }
}

/** True when an error looks like chromium failing to launch / not installed. */
function isLaunchFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Executable doesn't exist|browserType\.launch|Failed to launch|playwright install|spawn .*ENOENT|Target page, context or browser has been closed/i.test(
      msg
    ) || /chromium/i.test(msg)
  );
}

beforeEach(() => {
  // Tests serve content on 127.0.0.1; opt into private hosts so urlGuard
  // permits the localhost render. loadConfig() reads process.env per-call.
  process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterAll(async () => {
  // Always release the shared browser, even if the test skipped.
  await browserPool.close().catch(() => undefined);
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("renderResource pre-capture actions", () => {
  it("clicks a button and captures the revealed content + a screenshot", async (ctx) => {
    const bound = await startServer();
    if (!bound || !origin) {
      ctx.skip();
      return;
    }

    let result;
    try {
      result = await renderResource(`${origin}/`, {
        actions: [
          { type: "waitForSelector", selector: "#btn" },
          { type: "click", selector: "#btn" },
          { type: "waitForSelector", selector: "#result" },
          { type: "screenshot" }
        ]
      });
    } catch (err) {
      if (isLaunchFailure(err)) {
        // Chromium unavailable in this environment: skip gracefully.
        ctx.skip();
        return;
      }
      throw err;
    }

    const bodyText = result.body.toString("utf-8");
    expect(bodyText).toContain(REVEALED_TEXT);

    expect(result.actionScreenshots).toBeDefined();
    expect(result.actionScreenshots).toHaveLength(1);
    expect(typeof result.actionScreenshots![0]).toBe("string");
    expect(result.actionScreenshots![0].length).toBeGreaterThan(0);
  }, 60_000);
});
