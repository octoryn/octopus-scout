import { lookup } from "node:dns/promises";
import { loadConfig } from "../config.js";

/**
 * SSRF / URL safety guard.
 *
 * Blocks requests that target private, loopback, link-local, or otherwise
 * internal network ranges (including cloud metadata endpoints), and enforces
 * an optional host allow/block list from config. Designed to be called before
 * any outbound fetch / render / robots request.
 */

export class UrlNotAllowedError extends Error {
  readonly statusCode: number = 400;

  constructor(message: string) {
    super(message);
    this.name = "UrlNotAllowedError";
    // statusCode is set via field initializer above; reaffirm for callers that
    // inspect own-enumerable props after construction.
    Object.assign(this, { statusCode: 400 });
  }
}

// ---------------------------------------------------------------------------
// IP parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an IPv4 literal into its four octets. Accepts only strict
 * dotted-quad notation (no octal / hex / shorthand) so that ambiguous forms
 * are treated as "not a plain IPv4" rather than silently bypassing checks.
 */
function parseIpv4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;

  // 0.0.0.0/8 ("this" network) — includes 0.0.0.0 itself.
  if (a === 0) return true;
  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // Private 10.0.0.0/8
  if (a === 10) return true;
  // Private 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Private 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

/**
 * Parse an IPv6 literal into 8 16-bit groups. Handles "::" compression and
 * embedded IPv4 tails (e.g. ::ffff:1.2.3.4). Returns undefined for anything
 * that is not a recognizable IPv6 literal.
 */
function parseIpv6(input: string): number[] | undefined {
  let ip = input;
  if (ip.length === 0) return undefined;

  // Strip an optional zone id (e.g. fe80::1%eth0).
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);

  // Must look like IPv6: contain a colon.
  if (!ip.includes(":")) return undefined;

  // Split off an embedded IPv4 tail if present.
  let ipv4Tail: number[] | undefined;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (!v4) return undefined;
    ipv4Tail = v4;
    ip = ip.slice(0, lastColon + 1) + "0:0";
  }

  const halves = ip.split("::");
  if (halves.length > 2) return undefined;

  const splitGroups = (s: string): number[] | undefined => {
    if (s.length === 0) return [];
    const groups: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  let groups: number[];
  if (halves.length === 2) {
    const head = splitGroups(halves[0]);
    const back = splitGroups(halves[1]);
    if (!head || !back) return undefined;
    const missing = 8 - (head.length + back.length);
    if (missing < 0) return undefined;
    groups = [...head, ...new Array<number>(missing).fill(0), ...back];
  } else {
    const all = splitGroups(ip);
    if (!all) return undefined;
    groups = all;
  }

  if (groups.length !== 8) return undefined;

  // If there was an IPv4 tail, fold its octets into the final two groups.
  if (ipv4Tail) {
    groups[6] = (ipv4Tail[0] << 8) | ipv4Tail[1];
    groups[7] = (ipv4Tail[2] << 8) | ipv4Tail[3];
  }

  return groups;
}

function isPrivateIpv6(groups: number[]): boolean {
  // Unspecified ::
  if (groups.every((g) => g === 0)) return true;
  // Loopback ::1
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // Unique local addresses fc00::/7 (first 7 bits are 1111 110)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 (first 10 bits are 1111 1110 10)
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

/**
 * Detect an IPv4-mapped or IPv4-compatible IPv6 address and return the
 * embedded IPv4 octets so the caller can re-check them as IPv4.
 *   ::ffff:x.x.x.x  -> mapped
 *   ::x.x.x.x       -> compatible (last 32 bits, high groups zero)
 */
function extractMappedIpv4(groups: number[]): number[] | undefined {
  const highZero = groups.slice(0, 5).every((g) => g === 0);
  if (!highZero) return undefined;

  const isMapped = groups[5] === 0xffff;
  const isCompat = groups[5] === 0x0000;
  if (!isMapped && !isCompat) return undefined;

  const a = (groups[6] >> 8) & 0xff;
  const b = groups[6] & 0xff;
  const c = (groups[7] >> 8) & 0xff;
  const d = groups[7] & 0xff;
  return [a, b, c, d];
}

/**
 * Returns true if the given IP literal falls in a private, loopback,
 * link-local, CGNAT, or otherwise non-public range. Unparseable input
 * returns false (the caller decides what to do with non-IP hostnames).
 */
export function isPrivateIp(ip: string): boolean {
  const raw = ip.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (raw.length === 0) return false;

  const v4 = parseIpv4(raw);
  if (v4) return isPrivateIpv4(v4);

  const v6 = parseIpv6(raw);
  if (v6) {
    // Unwrap IPv4-mapped / -compatible addresses and re-check as IPv4.
    const mapped = extractMappedIpv4(v6);
    if (mapped) return isPrivateIpv4(mapped);
    return isPrivateIpv6(v6);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Host allow / block list matching
// ---------------------------------------------------------------------------

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * True if `host` exactly equals an entry, or is a subdomain (suffix) of one.
 * e.g. entry "example.com" matches "example.com" and "api.example.com".
 */
function hostMatchesList(host: string, entries: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of entries) {
    if (h === entry) return true;
    if (h.endsWith("." + entry)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

interface ParsedTarget {
  url: URL;
  host: string;
}

function parseAndValidateProtocol(inputUrl: string): ParsedTarget {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    throw new UrlNotAllowedError(`Invalid URL: ${inputUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlNotAllowedError(`Disallowed protocol: ${url.protocol}`);
  }

  // URL.hostname strips the brackets from IPv6 literals already.
  const host = url.hostname;
  if (host.length === 0) {
    throw new UrlNotAllowedError(`URL has no host: ${inputUrl}`);
  }

  return { url, host };
}

/**
 * Apply the protocol + allow/block-list + literal-IP checks shared by both the
 * sync and async guards. Returns:
 *   - "skip"  : config.allowPrivateHosts is set; caller should not do DNS work.
 *   - "check" : caller may proceed to the (async) DNS resolution step.
 */
function applyStaticChecks(host: string): "skip" | "check" {
  const config = loadConfig();

  const blocklist = parseList(config.hostBlocklist);
  if (blocklist.length > 0 && hostMatchesList(host, blocklist)) {
    throw new UrlNotAllowedError(`Host is blocklisted: ${host}`);
  }

  const allowlist = parseList(config.hostAllowlist);
  if (allowlist.length > 0 && !hostMatchesList(host, allowlist)) {
    throw new UrlNotAllowedError(`Host is not on the allowlist: ${host}`);
  }

  if (config.allowPrivateHosts) {
    return "skip";
  }

  // If the hostname is itself an IP literal, check it directly.
  if (isPrivateIp(host)) {
    throw new UrlNotAllowedError(`Host resolves to a private address: ${host}`);
  }

  return "check";
}

/**
 * Assert that the given URL is safe to fetch. Performs protocol validation,
 * allow/block-list enforcement, literal-IP checks, and DNS resolution to block
 * hostnames that resolve to internal addresses (DNS-rebinding defense).
 *
 * Throws UrlNotAllowedError (statusCode 400) when the URL is disallowed.
 * Never throws for hosts that merely fail to resolve — the subsequent fetch
 * surfaces that network error instead.
 */
export async function assertUrlAllowed(inputUrl: string): Promise<void> {
  const { host } = parseAndValidateProtocol(inputUrl);

  const mode = applyStaticChecks(host);
  if (mode === "skip") return;

  // If the host is an IP literal it was already checked synchronously and
  // there is nothing to resolve.
  if (parseIpv4(host) || parseIpv6(host)) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    // Unresolvable host: let the real fetch produce the network error.
    return;
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new UrlNotAllowedError(`Host ${host} resolves to a private address: ${address}`);
    }
  }
}

/**
 * Synchronous variant of assertUrlAllowed for callers that cannot await.
 * Performs every check except DNS resolution (protocol, allow/block-list,
 * and literal-IP checks only).
 *
 * Throws UrlNotAllowedError (statusCode 400) when the URL is disallowed.
 */
export function assertUrlAllowedSync(inputUrl: string): void {
  const { host } = parseAndValidateProtocol(inputUrl);
  applyStaticChecks(host);
}
