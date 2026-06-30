import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { loadConfig, type AppConfig } from "./config.js";

/**
 * Parse a comma/whitespace-separated list of API keys into a clean array.
 * Trims each entry and drops empties.
 */
export function parseApiKeys(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Decide whether a given request should require authentication, given the mode.
 *
 * - "off"   => never protected.
 * - "all"   => everything protected EXCEPT a GET to "/health".
 * - "write" => protected when the method mutates (POST/PUT/PATCH/DELETE) OR the
 *              path is governance/admin-sensitive ("/governance", "/audit", "/admin")
 *              OR the path is a governance/operational READ route that exposes
 *              operational data and target URLs ("/metrics", "/events", "/webhooks");
 *              otherwise not protected.
 */
export function isProtected(method: string, path: string, mode: "off" | "write" | "all"): boolean {
  if (mode === "off") return false;

  const upperMethod = method.toUpperCase();

  if (mode === "all") {
    return !(upperMethod === "GET" && path === "/health");
  }

  // mode === "write"
  const isMutating =
    upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH" || upperMethod === "DELETE";
  return (
    isMutating ||
    path.startsWith("/governance") ||
    path.startsWith("/audit") ||
    path.startsWith("/admin") ||
    path.startsWith("/metrics") ||
    path.startsWith("/events") ||
    path.startsWith("/webhooks")
  );
}

/**
 * Strip any query string (and fragment) from a path so route matching is exact.
 */
function stripQuery(path: string): string {
  const q = path.indexOf("?");
  const trimmed = q === -1 ? path : path.slice(0, q);
  const h = trimmed.indexOf("#");
  return h === -1 ? trimmed : trimmed.slice(0, h);
}

/**
 * Extract a bearer token from the "authorization" header or the value of the
 * "x-api-key" header. Returns undefined if neither is present.
 */
function extractToken(request: FastifyRequest): string | undefined {
  const authHeader = request.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match) return match[1].trim();
  }
  const apiKeyHeader = request.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim();
  }
  if (Array.isArray(apiKeyHeader) && apiKeyHeader.length > 0) {
    const first = apiKeyHeader[0]?.trim();
    if (first) return first;
  }
  return undefined;
}

/**
 * SHA-256 a value to a fixed-width Buffer so two digests are always the same
 * length and can be compared with `timingSafeEqual` without leaking length.
 */
function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time membership check: returns true iff `token` equals one of the
 * configured keys. Compares the SHA-256 digest of the token against the
 * pre-computed digest of every key, accumulating the result without
 * early-returning so the timing does not depend on which (if any) key matched.
 */
function matchesAnyKey(token: string, keyDigests: Buffer[]): boolean {
  const tokenDigest = sha256Buffer(token);
  let matched = false;
  for (const keyDigest of keyDigests) {
    if (timingSafeEqual(tokenDigest, keyDigest)) {
      matched = true;
    }
  }
  return matched;
}

let warnedAuthMisconfig = false;

/**
 * Build a Fastify `onRequest` hook that enforces API-key auth based on config.
 *
 * - authMode "off": always a no-op.
 * - authMode "write"/"all" with NO keys configured: fail-closed — protected
 *   routes are rejected with 503 {error:"auth_misconfigured"} (a one-time warn
 *   is logged) rather than silently leaving the server fully open.
 * - otherwise: protected routes require a valid key supplied via a Bearer
 *   "authorization" header or the "x-api-key" header, checked in constant time.
 */
export function createAuthHook(config: AppConfig = loadConfig()) {
  const keys = parseApiKeys(config.apiKeys);
  const keyDigests = keys.map(sha256Buffer);
  const misconfigured = config.authMode !== "off" && keys.length === 0;

  if (misconfigured && !warnedAuthMisconfig) {
    warnedAuthMisconfig = true;
    console.warn(
      "[octopus-scout] OCTORYN_SCOUT_AUTH_MODE is set but no OCTORYN_SCOUT_API_KEYS configured — protected routes will be rejected with 503 (fail-closed)."
    );
  }

  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (config.authMode === "off") {
      return;
    }

    const rawPath = request.routeOptions?.url ?? request.url;
    const path = stripQuery(rawPath);

    if (!isProtected(request.method, path, config.authMode)) {
      return;
    }

    if (misconfigured) {
      return reply.code(503).send({
        error: "auth_misconfigured",
        message: "OCTORYN_SCOUT_AUTH_MODE is set but no OCTORYN_SCOUT_API_KEYS configured"
      });
    }

    const token = extractToken(request);
    if (!token || !matchesAnyKey(token, keyDigests)) {
      return reply.code(401).send({ error: "unauthorized", message: "valid API key required" });
    }
    // valid key -> allow request to continue
    return;
  };
}
