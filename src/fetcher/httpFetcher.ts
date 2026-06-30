import { loadConfig } from "../config.js";
import { effectiveRateLimitMs } from "../governance/policy.js";
import type { FetchedResource, ProxyConfig } from "../types.js";
import { domainOf, normalizeUrl } from "../utils/url.js";
import { waitForDomainSlot } from "./rateLimiter.js";
import { assertUrlAllowed } from "./urlGuard.js";
import { assertContentLength, isAllowedContentType, readBodyCapped, ContentRejectedError } from "./content.js";
import { buildFetchHeaders, parseExtraHeaders, uaClientHints } from "./stealth.js";
import { pickProxy, proxiedFetch } from "./proxy.js";
import { recordBytes, recordDomain, recordRequest, recordStatus } from "../metrics.js";

const MAX_REDIRECTS = 5;

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  rateLimitMs?: number;
  /**
   * Explicit proxy to route this request through. When omitted, a proxy is
   * selected from the configured pool via {@link pickProxy} (round-robin);
   * when none is configured the request goes direct.
   */
  proxy?: ProxyConfig;
}

export async function fetchResource(inputUrl: string, options: FetchOptions = {}): Promise<FetchedResource> {
  const config = loadConfig();
  const url = normalizeUrl(inputUrl);
  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;
  const userAgent = options.userAgent ?? config.userAgent;
  const started = performance.now();

  recordRequest("fetch");
  recordDomain(domainOf(url));

  await assertUrlAllowed(url);

  // Honor any per-domain override from the loaded governance policy. The base
  // delay is the caller-supplied rateLimitMs (else the global config default);
  // effectiveRateLimitMs widens it to the policy's domain.rateLimitMs when the
  // matched domain declares a larger interval. This is the single layer that
  // has both the request URL and the rate-limit gate, so the policy lookup is
  // wired here rather than threaded through the FetchProvider seam.
  const baseRateLimitMs = options.rateLimitMs ?? config.domainRateLimitMs;
  await waitForDomainSlot(url, effectiveRateLimitMs(url, baseRateLimitMs));

  // When stealth is on, prefer UA-consistent Client Hints over the static
  // Windows/Chrome-126 set baked into buildFetchHeaders' stealthHeaders().
  const extra: Record<string, string> = parseExtraHeaders();
  if (config.stealth) {
    Object.assign(extra, uaClientHints(userAgent));
  }

  const requestHeaders = buildFetchHeaders(
    {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml,application/pdf,text/plain;q=0.9,*/*;q=0.8"
    },
    { stealth: config.stealth, extra }
  );

  // Resolve a proxy: explicit option wins, else round-robin the configured
  // pool. Undefined => direct fetch (graceful degradation).
  const proxy = options.proxy ?? pickProxy();

  if (proxy) {
    const result = await proxiedFetch(url, {
      proxy,
      headers: requestHeaders,
      timeoutMs,
      maxBytes: config.maxContentBytes,
      // Re-validate every redirect hop against the SSRF guard.
      validate: assertUrlAllowed
    });

    recordStatus(result.status);

    // proxiedFetch already enforced the hard byte cap via maxBytes, but reuse
    // the declared content-length and content-type guards for parity with the
    // direct path.
    assertContentLength(result.headers["content-length"] ?? null);
    if (!isAllowedContentType(result.contentType)) {
      throw new ContentRejectedError(`Disallowed content-type: ${result.contentType}`, 415);
    }

    recordBytes(result.body.byteLength);

    return {
      url,
      finalUrl: result.finalUrl,
      status: result.status,
      ok: result.ok,
      contentType: result.contentType,
      headers: result.headers,
      body: result.body,
      fetchedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started)
    };
  }

  // Manual redirect loop: `fetch(redirect:"follow")` would transparently chase
  // a 3xx Location to an internal host, bypassing the SSRF guard. We follow
  // hops ourselves and re-validate each target. The initial `url` is already
  // validated above.
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = url;
  let response: Response;
  let hop = 0;
  for (;;) {
    response = await fetch(currentUrl, { redirect: "manual", signal, headers: requestHeaders });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) {
        throw Object.assign(new Error(`fetchResource: exceeded ${MAX_REDIRECTS} redirects`), { statusCode: 502 });
      }
      currentUrl = new URL(location, currentUrl).toString();
      await assertUrlAllowed(currentUrl);
      hop += 1;
      continue;
    }
    break;
  }

  recordStatus(response.status);

  const contentType = response.headers.get("content-type") ?? "";
  assertContentLength(response.headers.get("content-length"));
  if (!isAllowedContentType(contentType)) {
    throw new ContentRejectedError(`Disallowed content-type: ${contentType}`, 415);
  }

  const body = await readBodyCapped(response);
  recordBytes(body.byteLength);
  const headers = Object.fromEntries(response.headers.entries());

  return {
    url,
    finalUrl: response.url || currentUrl,
    status: response.status,
    ok: response.ok,
    contentType,
    headers,
    body,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started)
  };
}
