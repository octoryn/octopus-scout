import net from "node:net";
import tls from "node:tls";
import { loadConfig } from "../config.js";
import type { ProxyConfig } from "../types.js";

/**
 * BYO (bring-your-own) HTTP proxy support, hand-rolled on Node built-ins only
 * (node:net + node:tls). ZERO new dependencies.
 *
 * - `parseProxies` turns the configured comma/whitespace list of proxy URLs
 *   (`http://[user:pass@]host:port`) into {@link ProxyConfig} objects with the
 *   credentials stripped out of `server` and carried separately.
 * - `pickProxy` round-robins across the configured proxies via a module-level
 *   counter (so successive fetches spread across the pool).
 * - `proxiedFetch` performs an HTTP(S) GET *through* an HTTP proxy: for https
 *   targets it issues a CONNECT tunnel then upgrades the raw socket to TLS; for
 *   http targets it sends an absolute-form request line to the proxy. It parses
 *   the status line, headers and body (Content-Length or chunked), follows
 *   redirects, and enforces timeout + byte caps.
 *
 * Nothing here throws at import time and `parseProxies`/`pickProxy` never throw.
 */

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Parse the configured `proxyUrls` (comma/whitespace separated) into a list of
 * {@link ProxyConfig}. Each entry must be a valid `http://[user:pass@]host:port`
 * URL; the returned `server` is the scheme+host+port only (credentials removed)
 * and any userinfo becomes `username`/`password`. Invalid entries are skipped;
 * an unset/blank/all-invalid list yields `[]`. Never throws.
 */
export function parseProxies(raw: string | undefined = loadConfig().proxyUrls): ProxyConfig[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }
  const tokens = raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const out: ProxyConfig[] = [];
  for (const token of tokens) {
    let parsed: URL;
    try {
      parsed = new URL(token);
    } catch {
      continue;
    }
    // We tunnel through HTTP(S) proxies only.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      continue;
    }
    if (parsed.hostname === "") {
      continue;
    }
    // Build server without credentials: scheme://host[:port]
    const host = parsed.hostname;
    const port = parsed.port;
    const server = port ? `${parsed.protocol}//${host}:${port}` : `${parsed.protocol}//${host}`;

    const entry: ProxyConfig = { server };
    if (parsed.username !== "") {
      entry.username = decodeURIComponent(parsed.username);
    }
    if (parsed.password !== "") {
      entry.password = decodeURIComponent(parsed.password);
    }
    out.push(entry);
  }
  return out;
}

// Module-level round-robin cursor. Intentionally process-wide so that
// successive fetches (even from different call sites) rotate the pool.
let rotationCounter = 0;

/**
 * Round-robin one {@link ProxyConfig} from the configured pool, advancing a
 * module-level cursor on each call. Returns `undefined` when none are
 * configured. Never throws.
 */
export function pickProxy(proxies: ProxyConfig[] = parseProxies()): ProxyConfig | undefined {
  if (proxies.length === 0) {
    return undefined;
  }
  const index = rotationCounter % proxies.length;
  rotationCounter = (rotationCounter + 1) % Number.MAX_SAFE_INTEGER;
  return proxies[index];
}

/** Reset the round-robin cursor (test seam). */
export function resetProxyRotation(): void {
  rotationCounter = 0;
}

/** Parsed proxy endpoint (host + numeric port). */
interface ProxyEndpoint {
  host: string;
  port: number;
}

function proxyEndpoint(proxy: ProxyConfig): ProxyEndpoint {
  const url = new URL(proxy.server);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { host: url.hostname, port };
}

function proxyAuthHeader(proxy: ProxyConfig): string | undefined {
  if (proxy.username == null && proxy.password == null) {
    return undefined;
  }
  const raw = `${proxy.username ?? ""}:${proxy.password ?? ""}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

interface RawHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * The public result shape of {@link proxiedFetch}, intentionally close to the
 * fields {@link FetchedResource} needs (status / ok / finalUrl / headers /
 * body / contentType) so the caller can adapt it cheaply.
 */
export interface ProxiedFetchResult {
  status: number;
  ok: boolean;
  finalUrl: string;
  headers: Record<string, string>;
  body: Buffer;
  contentType: string;
}

export interface ProxiedFetchOptions {
  proxy: ProxyConfig;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Called with each redirect target URL before it is followed. Throw to block
   * it (e.g. an SSRF guard). The initial URL is assumed pre-validated by the
   * caller; this re-validates every subsequent hop.
   */
  validate?: (url: string) => void | Promise<void>;
}

/**
 * Fetch `url` through an HTTP proxy using only node:net/node:tls. Follows up to
 * ~5 redirects (re-tunnelling per hop). Throws a descriptive Error on
 * proxy/connect/parse failure or when the body exceeds `maxBytes`.
 */
export async function proxiedFetch(url: string, opts: ProxiedFetchOptions): Promise<ProxiedFetchResult> {
  const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;

  let current = url;
  const seen = new Set<string>();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(current);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`proxiedFetch: unsupported target protocol "${target.protocol}"`);
    }

    const response =
      target.protocol === "https:"
        ? await httpsViaConnect(target, opts.proxy, opts.headers ?? {}, timeoutMs, maxBytes)
        : await httpViaProxy(target, opts.proxy, opts.headers ?? {}, timeoutMs, maxBytes);

    // Redirect handling (3xx with a Location header).
    if (response.status >= 300 && response.status < 400 && response.headers["location"]) {
      if (hop === MAX_REDIRECTS) {
        throw new Error(`proxiedFetch: exceeded ${MAX_REDIRECTS} redirects for ${url}`);
      }
      const next = new URL(response.headers["location"], target).toString();
      if (seen.has(next)) {
        throw new Error(`proxiedFetch: redirect loop detected at ${next}`);
      }
      // Re-validate the redirect target before following it — without this an
      // attacker can redirect a public URL to an internal one (SSRF).
      await opts.validate?.(next);
      seen.add(next);
      current = next;
      continue;
    }

    const contentType = response.headers["content-type"] ?? "";
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      finalUrl: target.toString(),
      headers: response.headers,
      body: response.body,
      contentType
    };
  }

  // Unreachable: the loop either returns or throws.
  throw new Error(`proxiedFetch: failed to fetch ${url}`);
}

/**
 * Open a plain TCP connection to the proxy, with a connect timeout. Resolves
 * with the connected socket.
 */
function connectToProxy(endpoint: ProxyEndpoint, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    let settled = false;

    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      resolve(socket);
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`proxy connect failed (${endpoint.host}:${endpoint.port}): ${err.message}`));
    };
    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`proxy connect timed out (${endpoint.host}:${endpoint.port})`));
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

/**
 * Issue an HTTP CONNECT to the proxy to open a tunnel to `host:port`, then
 * resolve once we read the "200 Connection Established" response. Any leftover
 * bytes after the CONNECT response header are returned so they are not lost.
 */
function sendConnect(
  socket: net.Socket,
  host: string,
  port: number,
  proxy: ProxyConfig,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    // Absolute deadline: the idle socket timeout below re-arms on every byte, so
    // it cannot bound the total CONNECT phase on its own. This setTimeout fires
    // once, timeoutMs after we start, regardless of drip-fed bytes.
    const deadline = setTimeout(() => {
      fail(`proxiedFetch: timeout`);
    }, timeoutMs);
    // Do not let this timer keep the event loop alive on its own.
    if (typeof deadline.unref === "function") {
      deadline.unref();
    }

    const cleanup = (): void => {
      clearTimeout(deadline);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("close", onClose);
      socket.setTimeout(0);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error(message));
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const head = buffer.subarray(0, headerEnd).toString("latin1");
      const statusLine = head.split("\r\n")[0] ?? "";
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
      const code = match ? Number(match[1]) : 0;
      if (code !== 200) {
        fail(`proxy CONNECT to ${host}:${port} failed: ${statusLine || "no status line"}`);
        return;
      }
      settled = true;
      cleanup();
      // Bytes after the CONNECT response header (rare, but possible).
      resolve(buffer.subarray(headerEnd + 4));
    };
    const onError = (err: Error): void => fail(`proxy CONNECT socket error: ${err.message}`);
    const onTimeout = (): void => fail(`proxy CONNECT to ${host}:${port} timed out`);
    const onClose = (): void => fail(`proxy closed connection during CONNECT to ${host}:${port}`);

    socket.setTimeout(timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("close", onClose);

    const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
    const auth = proxyAuthHeader(proxy);
    if (auth) {
      lines.push(`Proxy-Authorization: ${auth}`);
    }
    lines.push("Connection: keep-alive", "", "");
    socket.write(lines.join("\r\n"), "latin1");
  });
}

/**
 * HTTPS target: CONNECT tunnel through the proxy, TLS-upgrade the raw socket
 * (servername = target host), then GET origin-form over the encrypted socket.
 */
async function httpsViaConnect(
  target: URL,
  proxy: ProxyConfig,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number
): Promise<RawHttpResponse> {
  const endpoint = proxyEndpoint(proxy);
  const host = target.hostname;
  const port = target.port ? Number(target.port) : 443;

  const rawSocket = await connectToProxy(endpoint, timeoutMs);
  let leftover: Buffer;
  try {
    leftover = await sendConnect(rawSocket, host, port, proxy, timeoutMs);
  } catch (err) {
    rawSocket.destroy();
    throw err;
  }
  if (leftover.length > 0) {
    // Push any post-CONNECT bytes back so the TLS layer (or our reader) sees them.
    rawSocket.unshift(leftover);
  }

  const tlsSocket = await upgradeToTls(rawSocket, host, timeoutMs);
  try {
    const requestPath = `${target.pathname}${target.search}`;
    return await sendRequestAndRead(tlsSocket, host, requestPath, headers, timeoutMs, maxBytes);
  } finally {
    tlsSocket.destroy();
  }
}

/**
 * HTTP target: connect to the proxy and send an absolute-form request line
 * (`GET http://host/path HTTP/1.1`). The proxy fetches and relays the response.
 */
async function httpViaProxy(
  target: URL,
  proxy: ProxyConfig,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number
): Promise<RawHttpResponse> {
  const endpoint = proxyEndpoint(proxy);
  const host = target.host; // host[:port]
  const socket = await connectToProxy(endpoint, timeoutMs);
  try {
    const absoluteUri = `${target.protocol}//${target.host}${target.pathname}${target.search}`;
    const extra: Record<string, string> = {};
    const auth = proxyAuthHeader(proxy);
    if (auth) {
      extra["Proxy-Authorization"] = auth;
    }
    return await sendRequestAndRead(socket, host, absoluteUri, { ...headers, ...extra }, timeoutMs, maxBytes);
  } finally {
    socket.destroy();
  }
}

/** TLS-upgrade an existing connected socket. */
function upgradeToTls(socket: net.Socket, servername: string, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const tlsSocket = tls.connect({
      socket,
      servername,
      // SNI host; ALPN left default. Cert validation stays on by default.
      timeout: timeoutMs
    });
    const onSecure = (): void => {
      if (settled) return;
      settled = true;
      tlsSocket.removeListener("error", onError);
      tlsSocket.removeListener("timeout", onTimeout);
      tlsSocket.setTimeout(0);
      resolve(tlsSocket);
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      tlsSocket.destroy();
      reject(new Error(`TLS handshake with ${servername} failed: ${err.message}`));
    };
    const onTimeout = (): void => {
      if (settled) return;
      settled = true;
      tlsSocket.destroy();
      reject(new Error(`TLS handshake with ${servername} timed out`));
    };
    tlsSocket.once("secureConnect", onSecure);
    tlsSocket.once("error", onError);
    tlsSocket.once("timeout", onTimeout);
  });
}

/**
 * Write an HTTP/1.1 GET (`requestTarget` is origin-form for TLS or absolute-form
 * for plain proxying) and read the full response off `socket`. Parses the status
 * line + headers, then the body via Content-Length or chunked transfer-encoding.
 * Enforces `maxBytes` on the decoded body and `timeoutMs` on socket inactivity.
 */
function sendRequestAndRead(
  socket: net.Socket | tls.TLSSocket,
  hostHeader: string,
  requestTarget: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    // Header parse state.
    let headerEnd = -1;
    let status = 0;
    let statusText = "";
    let respHeaders: Record<string, string> = {};
    let contentLength: number | undefined;
    let chunked = false;

    // Incremental chunked-decode state, carried across 'data' events so we never
    // re-scan the whole accumulated body from offset 0 (which would be O(n^2)).
    // `chunkOffset` is an index into `buffer` (not the body); the decoded chunk
    // data accumulates in `chunkParts`/`chunkTotal`, and `chunkDone` records the
    // terminal zero-length chunk having been consumed.
    const chunkParts: Buffer[] = [];
    let chunkTotal = 0;
    let chunkOffset = -1; // -1 until the body start is known (headers parsed)
    let chunkDone = false;

    // Absolute deadline: socket.setTimeout below is an *idle* timeout that
    // re-arms on every byte, so a slow-drip server can hold the connection open
    // forever. This one-shot timer bounds the entire request/read regardless of
    // trickled bytes — matching the AbortSignal.timeout guarantee on the
    // non-proxy path.
    const deadline = setTimeout(() => {
      const sock = socket;
      fail(`proxiedFetch: timeout`);
      sock.destroy();
    }, timeoutMs);
    if (typeof deadline.unref === "function") {
      deadline.unref();
    }

    const cleanup = (): void => {
      clearTimeout(deadline);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onEnd);
      socket.setTimeout(0);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const succeed = (body: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status, statusText, headers: respHeaders, body });
    };

    const parseHeaders = (): boolean => {
      headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return false;
      }
      const head = buffer.subarray(0, headerEnd).toString("latin1");
      const lines = head.split("\r\n");
      const statusLine = lines.shift() ?? "";
      const match = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(statusLine);
      if (!match) {
        fail(`malformed status line: ${statusLine}`);
        return false;
      }
      status = Number(match[1]);
      statusText = match[2] ?? "";
      respHeaders = {};
      for (const line of lines) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        // Last value wins; sufficient for our use (we never need Set-Cookie joins).
        respHeaders[key] = value;
      }
      const te = (respHeaders["transfer-encoding"] ?? "").toLowerCase();
      chunked = te.includes("chunked");
      if (!chunked && respHeaders["content-length"] != null) {
        const len = Number(respHeaders["content-length"]);
        if (Number.isFinite(len) && len >= 0) {
          contentLength = len;
        }
      }
      return true;
    };

    // Consume as many complete chunks as are currently available in `buffer`,
    // advancing `chunkOffset` so subsequent calls only look at newly arrived
    // bytes. Returns "overflow" on cap breach, otherwise mutates the chunk state
    // (including `chunkDone`) and returns. O(bytes consumed) per call → O(n)
    // total across the whole body.
    const advanceChunked = (): "overflow" | void => {
      for (;;) {
        const lineEnd = buffer.indexOf("\r\n", chunkOffset);
        if (lineEnd === -1) {
          return; // incomplete chunk-size line; wait for more.
        }
        const sizeLine = buffer.subarray(chunkOffset, lineEnd).toString("latin1").trim();
        const sizeToken = sizeLine.split(";")[0]?.trim() ?? "";
        const size = parseInt(sizeToken, 16);
        if (!Number.isFinite(size) || Number.isNaN(size) || size < 0) {
          return; // malformed; best-effort, treat as incomplete.
        }
        if (size === 0) {
          chunkDone = true;
          return;
        }
        const dataStart = lineEnd + 2;
        const dataEnd = dataStart + size;
        if (dataEnd + 2 > buffer.length) {
          return; // chunk data (+ trailing CRLF) not fully arrived yet.
        }
        chunkTotal += size;
        if (chunkTotal > maxBytes) {
          return "overflow";
        }
        // Copy (not subarray-view) the chunk data so we can safely compact
        // `buffer` below without aliasing freed bytes.
        chunkParts.push(Buffer.from(buffer.subarray(dataStart, dataEnd)));
        chunkOffset = dataEnd + 2; // skip the chunk's trailing CRLF.

        // Compact: drop everything we've consumed so the live buffer stays the
        // size of the unparsed remainder, not the whole body. This keeps the
        // per-'data' Buffer.concat in onData O(remainder) rather than O(n),
        // giving O(n) total work over a large streamed body.
        buffer = buffer.subarray(chunkOffset);
        chunkOffset = 0;
      }
    };

    const tryComplete = (): void => {
      if (headerEnd === -1) {
        if (!parseHeaders()) {
          return;
        }
        if (chunked) {
          // Body begins right after the headers; advanceChunked then compacts
          // `buffer` down to the unparsed remainder as it consumes chunks.
          chunkOffset = headerEnd + 4;
        }
      }

      // No-body statuses.
      if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
        succeed(Buffer.alloc(0));
        return;
      }

      if (chunked) {
        const result = advanceChunked();
        if (result === "overflow") {
          fail(`proxiedFetch: response body exceeds maximum ${maxBytes} bytes`);
          return;
        }
        if (chunkDone) {
          succeed(Buffer.concat(chunkParts, chunkTotal));
        }
        // else: wait for more data.
        return;
      }

      // Non-chunked: `buffer` is never compacted, so the body still starts at
      // headerEnd + 4.
      const rawBody = buffer.subarray(headerEnd + 4);

      if (contentLength != null) {
        if (rawBody.length > maxBytes || contentLength > maxBytes) {
          fail(`proxiedFetch: response body exceeds maximum ${maxBytes} bytes`);
          return;
        }
        if (rawBody.length >= contentLength) {
          succeed(rawBody.subarray(0, contentLength));
        }
        // else: wait for more data.
        return;
      }

      // No Content-Length and not chunked: body terminates at connection close.
      if (rawBody.length > maxBytes) {
        fail(`proxiedFetch: response body exceeds maximum ${maxBytes} bytes`);
        return;
      }
      // Completion is handled in onEnd.
    };

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!settled && buffer.length > maxBytes + 1_048_576) {
        // Guard runaway buffers well past the cap (allows header slack).
        fail(`proxiedFetch: response exceeds maximum ${maxBytes} bytes`);
        return;
      }
      tryComplete();
    };
    const onEnd = (): void => {
      if (settled) return;
      if (headerEnd === -1 && !parseHeaders()) {
        fail("proxiedFetch: connection closed before response headers were received");
        return;
      }
      if (chunked) {
        if (chunkOffset === -1) {
          chunkOffset = headerEnd + 4;
        }
        const result = advanceChunked();
        if (result === "overflow") {
          fail(`proxiedFetch: response body exceeds maximum ${maxBytes} bytes`);
          return;
        }
        // Connection closed: emit whatever complete chunks we decoded (the
        // terminal zero chunk may be absent on an early close — best-effort).
        succeed(Buffer.concat(chunkParts, chunkTotal));
        return;
      }
      const rawBody = buffer.subarray(headerEnd + 4);
      if (contentLength != null) {
        succeed(rawBody.subarray(0, Math.min(rawBody.length, contentLength)));
        return;
      }
      // Connection-close-delimited body.
      succeed(rawBody);
    };
    const onError = (err: Error): void => fail(`proxiedFetch socket error: ${err.message}`);
    const onTimeout = (): void => fail("proxiedFetch: socket timed out waiting for response");

    socket.setTimeout(timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.once("end", onEnd);
    socket.once("close", onEnd);

    // Build and send the request.
    const merged: Record<string, string> = {
      Host: hostHeader,
      Connection: "close",
      "Accept-Encoding": "identity",
      ...headers
    };
    // Header keys are matched case-insensitively below; normalize known dupes so
    // a caller-supplied "host"/"connection" overrides our defaults cleanly.
    const lower = new Map<string, string>();
    const lines: string[] = [`GET ${requestTarget} HTTP/1.1`];
    for (const [key, value] of Object.entries(merged)) {
      const lk = key.toLowerCase();
      if (lower.has(lk)) {
        continue;
      }
      lower.set(lk, value);
      lines.push(`${key}: ${value}`);
    }
    lines.push("", "");
    socket.write(lines.join("\r\n"), "latin1");
  });
}
