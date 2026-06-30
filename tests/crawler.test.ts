import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { crawl } from "../src/crawl/crawler.js";

/**
 * Hermetic crawler tests. We exercise the URL filtering / frontier logic
 * (maxDepth, maxPages, same-origin) against a tiny in-process http server
 * serving a handful of interlinked HTML pages on 127.0.0.1. No external
 * network is used. If a server cannot bind, the suite skips gracefully.
 */

interface TestServer {
  origin: string; // e.g. http://127.0.0.1:54321
  host: string; // hostname only (127.0.0.1)
  port: number;
  url(pathname: string): string;
  close(): Promise<void>;
  requestCount(): number;
}

/** Minimal HTML page with the given title, body content, and links. */
function htmlPage(title: string, links: string[]): string {
  const anchors = links.map((href, i) => `<a href="${href}">Link ${i}</a>`).join("\n      ");
  return `<!doctype html>
<html lang="en">
  <head><title>${title}</title></head>
  <body>
    <article>
      <h1>${title}</h1>
      <p>This page exists purely so the crawler frontier logic has something
      real to fetch, extract, and follow during the hermetic test run. It has
      enough prose for the extractor to treat it as an article body.</p>
      ${anchors}
    </article>
  </body>
</html>`;
}

/**
 * Start an http server serving a fixed routing table of HTML pages.
 * `routes` maps a pathname -> array of hrefs to embed as links on that page.
 * Returns undefined if binding fails (so callers can skip).
 */
async function startServer(routes: Record<string, string[]>): Promise<TestServer | undefined> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    const pathname = (req.url ?? "/").split("?")[0];
    const links = routes[pathname];
    if (links === undefined) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><html><body>not found</body></html>");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(htmlPage(`Page ${pathname}`, links));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch {
    return undefined;
  }

  const addr = server.address() as AddressInfo;
  const host = "127.0.0.1";
  const origin = `http://${host}:${addr.port}`;

  return {
    origin,
    host,
    port: addr.port,
    url: (pathname: string) => `${origin}${pathname}`,
    requestCount: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

describe("crawl", () => {
  let dataDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(() => {
    savedEnv = {
      OCTORYN_SCOUT_DATA_DIR: process.env.OCTORYN_SCOUT_DATA_DIR,
      OCTORYN_SCOUT_DOMAIN_RATE_LIMIT_MS: process.env.OCTORYN_SCOUT_DOMAIN_RATE_LIMIT_MS,
      OCTORYN_SCOUT_DEFAULT_TIMEOUT_MS: process.env.OCTORYN_SCOUT_DEFAULT_TIMEOUT_MS,
      OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS: process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS
    };
    // Keep tests fast: no per-domain throttling, short timeout.
    process.env.OCTORYN_SCOUT_DOMAIN_RATE_LIMIT_MS = "0";
    process.env.OCTORYN_SCOUT_DEFAULT_TIMEOUT_MS = "5000";
    // The SSRF guard blocks private/loopback IPs by default. These hermetic
    // tests serve content on 127.0.0.1, so opt into private hosts for the
    // duration of the suite (restored in afterAll). This does not weaken the
    // guard's production default.
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  beforeEach(() => {
    // Unique file-backed store per test, isolated from the user's project.
    dataDir = path.join(os.tmpdir(), `octopus-scout-crawl-${randomUUID()}`);
    process.env.OCTORYN_SCOUT_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("crawls interlinked same-origin pages and follows links breadth-first", async () => {
    // a -> b, c ; b -> d ; c -> d ; d is a leaf
    const server = await startServer({
      "/a": ["/b", "/c"],
      "/b": ["/d"],
      "/c": ["/d"],
      "/d": []
    });
    if (!server) {
      console.warn("skipping: could not bind local http server");
      return;
    }
    try {
      const result = await crawl({
        url: server.url("/a"),
        maxDepth: 3,
        maxPages: 50,
        useSitemap: false,
        respectRobots: false
      });

      const crawledPaths = new Set(result.pages.map((p) => new URL(p.url).pathname));
      expect(crawledPaths).toEqual(new Set(["/a", "/b", "/c", "/d"]));
      expect(result.pagesCrawled).toBe(4);
      // /d is reachable from both /b and /c but must be fetched only once.
      expect(result.pages.filter((p) => new URL(p.url).pathname === "/d")).toHaveLength(1);

      // Depths reflect BFS distance from the root.
      const depthOf = (pathname: string) => result.pages.find((p) => new URL(p.url).pathname === pathname)?.depth;
      expect(depthOf("/a")).toBe(0);
      expect(depthOf("/b")).toBe(1);
      expect(depthOf("/c")).toBe(1);
      expect(depthOf("/d")).toBe(2);

      expect(result.rootUrl).toBe(server.url("/a"));
      expect(result.discoveredUrls).toBeGreaterThanOrEqual(4);
    } finally {
      await server.close();
    }
  });

  it("respects maxDepth and does not fetch pages beyond it", async () => {
    // Linear chain a -> b -> c -> d.
    const server = await startServer({
      "/a": ["/b"],
      "/b": ["/c"],
      "/c": ["/d"],
      "/d": []
    });
    if (!server) {
      console.warn("skipping: could not bind local http server");
      return;
    }
    try {
      const result = await crawl({
        url: server.url("/a"),
        maxDepth: 1,
        maxPages: 50,
        useSitemap: false,
        respectRobots: false
      });

      const crawledPaths = new Set(result.pages.map((p) => new URL(p.url).pathname));
      // Depth 0 (/a) and depth 1 (/b) only; /c and /d are beyond maxDepth.
      expect(crawledPaths).toEqual(new Set(["/a", "/b"]));
      expect(crawledPaths.has("/c")).toBe(false);
      expect(crawledPaths.has("/d")).toBe(false);
      expect(result.pages.every((p) => p.depth <= 1)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("respects maxPages as a hard cap on fetched pages", async () => {
    // Star: root links to many children, all within depth 1.
    const children = ["/p1", "/p2", "/p3", "/p4", "/p5"];
    const routes: Record<string, string[]> = { "/root": children };
    for (const child of children) {
      routes[child] = [];
    }
    const server = await startServer(routes);
    if (!server) {
      console.warn("skipping: could not bind local http server");
      return;
    }
    try {
      const result = await crawl({
        url: server.url("/root"),
        maxDepth: 2,
        maxPages: 3,
        concurrency: 1,
        useSitemap: false,
        respectRobots: false
      });

      expect(result.pagesCrawled).toBeLessThanOrEqual(3);
      expect(result.pages.length).toBeLessThanOrEqual(3);
      // Root is always fetched first.
      expect(result.pages.some((p) => new URL(p.url).pathname === "/root")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("stays same-origin and does not follow cross-origin links", async () => {
    // A separate server represents a different origin. We bind it on 127.0.0.1
    // but reference it via the distinct 'localhost' hostname so the crawler's
    // host-equality filter treats it as cross-origin.
    const external = await startServer({ "/secret": [] });
    if (!external) {
      console.warn("skipping: could not bind external http server");
      return;
    }
    const externalLocalhostUrl = `http://localhost:${external.port}/secret`;

    const main = await startServer({
      // Root links to an internal page and to the external origin.
      "/home": ["/about", externalLocalhostUrl],
      "/about": []
    });
    if (!main) {
      console.warn("skipping: could not bind main http server");
      await external.close();
      return;
    }

    try {
      const result = await crawl({
        url: main.url("/home"),
        maxDepth: 3,
        maxPages: 50,
        sameOriginOnly: true,
        useSitemap: false,
        respectRobots: false
      });

      const crawledHosts = new Set(result.pages.map((p) => new URL(p.url).hostname));
      expect(crawledHosts).toEqual(new Set([main.host]));
      expect(result.pages.some((p) => new URL(p.url).hostname === "localhost")).toBe(false);

      const crawledPaths = new Set(result.pages.map((p) => new URL(p.url).pathname));
      expect(crawledPaths).toEqual(new Set(["/home", "/about"]));

      // The external server must never have been contacted.
      expect(external.requestCount()).toBe(0);
    } finally {
      await main.close();
      await external.close();
    }
  });

  it("records per-page failures without aborting the crawl", async () => {
    // /good links to /missing (404). The crawl should still complete and
    // report the failure rather than throwing.
    const server = await startServer({
      "/good": ["/missing"]
      // '/missing' is intentionally absent -> 404
    });
    if (!server) {
      console.warn("skipping: could not bind local http server");
      return;
    }
    try {
      const result = await crawl({
        url: server.url("/good"),
        maxDepth: 2,
        maxPages: 50,
        useSitemap: false,
        respectRobots: false
      });

      const good = result.pages.find((p) => new URL(p.url).pathname === "/good");
      expect(good?.ok).toBe(true);

      const missing = result.pages.find((p) => new URL(p.url).pathname === "/missing");
      // The 404 page is still fetched (it passes the filter) but is not ok.
      expect(missing).toBeDefined();
      expect(missing?.ok).toBe(false);
      expect(missing?.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
