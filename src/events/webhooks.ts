import { createHmac } from "node:crypto";
import { loadConfig } from "../config.js";
import { onEvent } from "./eventBus.js";
import type { ScoutEvent, ScoutEventType, WebhookDelivery } from "../types.js";

/**
 * Signed webhook delivery.
 *
 * Best-effort by design: if no webhook URLs are configured, every entry point
 * is a no-op. Delivery never throws out of the event subscriber, so webhook
 * failures can never break the core scrape/crawl/ingest pipeline.
 */

/** Bounded in-memory delivery log (newest entries pushed to the end). */
const MAX_DELIVERIES = 500;
let deliveries: WebhookDelivery[] = [];

let deliverySeq = 0;

function recordDelivery(delivery: WebhookDelivery): void {
  deliveries.push(delivery);
  if (deliveries.length > MAX_DELIVERIES) {
    deliveries.splice(0, deliveries.length - MAX_DELIVERIES);
  }
}

function nextDeliveryId(): string {
  deliverySeq += 1;
  return `whd_${Date.now().toString(36)}_${deliverySeq.toString(36)}`;
}

/** Hex HMAC-SHA256 of `body` keyed by `secret`. */
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Returns true when an event of `type` passes the configured filter.
 * The filter is a comma list of ScoutEventType or "*" (all).
 */
function eventPasses(filter: string[], type: ScoutEventType): boolean {
  if (filter.length === 0) return true;
  if (filter.includes("*")) return true;
  return filter.includes(type);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverToUrl(
  event: ScoutEvent,
  url: string,
  secret: string | undefined,
  timeoutMs: number,
  maxAttempts: number
): Promise<WebhookDelivery> {
  const body = JSON.stringify({ event });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-octoryn-event": event.type
  };
  if (secret) {
    headers["x-octoryn-signature"] = `sha256=${signPayload(body, secret)}`;
  }

  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatus = res.status;
      // Drain the body so the connection can be reused/closed cleanly.
      try {
        await res.arrayBuffer();
      } catch {
        // ignore body-drain errors
      }
      if (res.ok) {
        return {
          id: nextDeliveryId(),
          eventId: event.id,
          eventType: event.type,
          url,
          status: "delivered",
          attempts,
          statusCode: res.status,
          at: new Date().toISOString()
        };
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastStatus = undefined;
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempts < maxAttempts) {
      // Small exponential backoff: 200ms * 2^(attempt-1).
      await sleep(200 * 2 ** (attempts - 1));
    }
  }

  return {
    id: nextDeliveryId(),
    eventId: event.id,
    eventType: event.type,
    url,
    status: "failed",
    attempts,
    statusCode: lastStatus,
    error: lastError,
    at: new Date().toISOString()
  };
}

/**
 * Deliver an event to the given URLs (defaults to the configured webhook URLs).
 * Exposed for tests/manual use. Records one WebhookDelivery per URL. Never
 * throws — failures are captured in the returned delivery records.
 */
export async function deliverEvent(event: ScoutEvent, urls?: string[]): Promise<WebhookDelivery[]> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch {
    return [];
  }

  const targets = urls ?? parseList(config.webhookUrls);
  if (targets.length === 0) return [];

  const secret = config.webhookSecret;
  const timeoutMs = config.webhookTimeoutMs;
  const maxAttempts = config.webhookMaxAttempts;

  const results = await Promise.all(
    targets.map((url) =>
      deliverToUrl(event, url, secret, timeoutMs, maxAttempts).catch((err): WebhookDelivery => ({
        id: nextDeliveryId(),
        eventId: event.id,
        eventType: event.type,
        url,
        status: "failed",
        attempts: maxAttempts,
        error: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString()
      }))
    )
  );

  for (const delivery of results) {
    recordDelivery(delivery);
  }
  return results;
}

/** Returns recorded deliveries, newest-first. */
export function getWebhookDeliveries(limit?: number): WebhookDelivery[] {
  const newestFirst = deliveries.slice().reverse();
  if (typeof limit === "number" && limit >= 0) {
    return newestFirst.slice(0, limit);
  }
  return newestFirst;
}

/** Clear the in-memory delivery log (tests). */
export function resetWebhooks(): void {
  deliveries = [];
  deliverySeq = 0;
}

/**
 * Subscribe webhook delivery to the event bus.
 *
 * Reads webhook URLs, secret and event filter from config. If no URLs are
 * configured, returns a no-op unsubscribe. Otherwise subscribes to the bus and
 * delivers each matching event to every configured URL. Returns the unsubscribe
 * function. Never throws.
 */
export function initWebhooks(): () => void {
  const noop = (): void => {};

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch {
    return noop;
  }

  const urls = parseList(config.webhookUrls);
  if (urls.length === 0) return noop;

  const filter = parseList(config.webhookEvents);

  if (typeof onEvent !== "function") return noop;

  let unsubscribe: () => void;
  try {
    unsubscribe = onEvent((event: ScoutEvent) => {
      try {
        if (!eventPasses(filter, event.type)) return;
        // Fire-and-forget; deliverEvent never rejects but guard anyway.
        void deliverEvent(event, urls).catch(() => {});
      } catch {
        // Subscriber must never throw.
      }
    });
  } catch {
    return noop;
  }

  return typeof unsubscribe === "function" ? unsubscribe : noop;
}
