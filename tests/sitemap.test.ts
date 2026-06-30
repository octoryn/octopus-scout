import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic tests for fast site URL discovery (src/crawl/siteMap.ts).
 *
 * A tiny node:http server on 127.0.0.1 serves three resources:
 *   - /sitemap.xml : a urlset with a handful of same-origin <loc> entries
 *   - /            : an HTML page linking to same-origin paths plus one
 *                    external https URL (which must be excluded by default)
 *   - /robots.txt  : empty
 *
 * The SSRF guard blocks private/loopback hosts by default, so we opt in via
 * OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS before importing the module under test.
 * loadConfig() reads lazily off process.env; we still mutate env BEFORE a
 * vi.resetModules() + dynamic import so any module-scoped caching is bypassed.
 *
 * Everything is loopback-only; there is no real external network traffic. The
 * external link in the page is never fetched (mapSite only fetches the root and
 * the sitemap), so its presence is purely a same-origin filtering fixture.
 */

const MARKER = `octo-map-${randomUUID().slice(0, 8)}`;
const EXTERNAL_URL = "https://example.invalid/external-page";

// Same-origin paths discoverable from the sitemap.
const SITEMAP_PATHS = ["/", "/about", "/docs/guide"];
// Same-origin paths discoverable only from root-page links.
const LINK_ONLY_PATHS = ["/contact", "/blog/post-1"];

function sitemapXml(origin: string): string {
  const locs = SITEMAP_PATHS.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs}
</urlset>`;
}

function pageHtml(): string {
  // Links include same-origin relative paths (resolved against the page URL),
  // one duplicate of a sitemap path, and one external absolute URL.
  return `<!doctype html>
<html lang="en">
  <head><title>${MARKER} home</title></head>
  <body>
    <h1>${MARKER}</h1>
    <nav>
      <a href="/about">About (also in sitemap)</a>
      <a href="/contact">Contact</a>
      <a href="/blog/post-1">Blog post one</a>
      <a href="${EXTERNAL_URL}">External link</a>
    </nav>
  </body>
</html>`;
}

describe("siteMap: hermetic mapSite over a loopback server", () => {
  let server: Server | undefined;
  let baseUrl: string | undefined;
  let canBind = true;

  const prev: Record<string, string | undefined> = {};
  function snapshotEnv(...keys: string[]): void {
    for (const k of keys) prev[k] = process.env[k];
  }
  function restoreEnv(): void {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(async () => {
    snapshotEnv("OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS", "OCTORYN_SCOUT_MAP_MAX_URLS");
    process.env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS = "true";
    delete process.env.OCTORYN_SCOUT_MAP_MAX_URLS;

    canBind = true;
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      const origin = baseUrl ?? "";
      if (path === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("");
        return;
      }
      if (path === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
        res.end(sitemapXml(origin));
        return;
      }
      if (path === "/" || path === "") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(pageHtml());
        return;
      }
      // Other same-origin paths exist but are not crawled by mapSite; respond
      // with a minimal page anyway so nothing 404s if probed.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>${MARKER} ${path}</title>`);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    } catch {
      canBind = false;
    }
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    baseUrl = undefined;
    restoreEnv();
  });

  afterAll(() => {
    restoreEnv();
  });

  async function loadMapSite() {
    vi.resetModules();
    const mod = await import("../src/crawl/siteMap.js");
    return mod.mapSite;
  }

  it("collects sitemap locs and same-origin links, excluding external URLs", async (ctx) => {
    if (!canBind || !baseUrl) {
      ctx.skip();
      return;
    }
    const mapSite = await loadMapSite();
    const result = await mapSite({ url: baseUrl });

    // count is exactly the length of urls.
    expect(result.count).toBe(result.urls.length);
    expect(typeof result.fromSitemap).toBe("number");
    expect(typeof result.fromLinks).toBe("number");

    // All sitemap locs are present.
    for (const p of SITEMAP_PATHS) {
      const expected = p === "/" ? `${baseUrl}/` : `${baseUrl}${p}`;
      expect(result.urls).toContain(expected);
    }
    // Link-only same-origin paths are present.
    for (const p of LINK_ONLY_PATHS) {
      expect(result.urls).toContain(`${baseUrl}${p}`);
    }

    // The external URL is dropped under the default same-origin policy.
    expect(result.urls.some((u) => u.includes("example.invalid"))).toBe(false);

    // Sources contributed something and account for every collected URL.
    expect(result.fromSitemap).toBeGreaterThanOrEqual(SITEMAP_PATHS.length);
    expect(result.fromLinks).toBeGreaterThanOrEqual(LINK_ONLY_PATHS.length);
    expect(result.fromSitemap + result.fromLinks).toBe(result.count);

    expect(result.rootUrl).toContain("127.0.0.1");
  });

  it("search narrows results to matching URLs", async (ctx) => {
    if (!canBind || !baseUrl) {
      ctx.skip();
      return;
    }
    const mapSite = await loadMapSite();
    const result = await mapSite({ url: baseUrl, search: "docs" });

    expect(result.count).toBe(result.urls.length);
    expect(result.urls.length).toBeGreaterThan(0);
    for (const u of result.urls) {
      expect(u.toLowerCase()).toContain("docs");
    }
    expect(result.urls).toContain(`${baseUrl}/docs/guide`);
  });

  it("excludePaths drops a matching path", async (ctx) => {
    if (!canBind || !baseUrl) {
      ctx.skip();
      return;
    }
    const mapSite = await loadMapSite();
    const baseline = await mapSite({ url: baseUrl });
    expect(baseline.urls).toContain(`${baseUrl}/about`);

    const filtered = await mapSite({ url: baseUrl, excludePaths: ["/about"] });
    expect(filtered.urls).not.toContain(`${baseUrl}/about`);
    expect(filtered.count).toBe(filtered.urls.length);
    expect(filtered.count).toBeLessThan(baseline.count);
  }, 20000);

  it("limit caps the number of returned URLs", async (ctx) => {
    if (!canBind || !baseUrl) {
      ctx.skip();
      return;
    }
    const mapSite = await loadMapSite();
    const result = await mapSite({ url: baseUrl, limit: 2 });

    expect(result.urls.length).toBeLessThanOrEqual(2);
    expect(result.count).toBe(result.urls.length);
    expect(result.count).toBeLessThanOrEqual(2);
    expect(result.fromSitemap + result.fromLinks).toBe(result.count);
  });
});
