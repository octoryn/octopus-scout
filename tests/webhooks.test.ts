import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ScoutEvent } from "../src/types.js";

/**
 * Hermetic webhook delivery tests. All servers bind to 127.0.0.1 only; no
 * external network is touched. Singletons in webhooks.ts cache nothing at
 * import time except module-level state, but loadConfig() reads process.env
 * lazily, so we snapshot/restore env and use vi.resetModules()+dynamic import
 * to re-evaluate fresh config per test.
 */

interface Recorded {
  method?: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Receiver {
  url: string;
  recorded: Recorded[];
  close: () => Promise<void>;
}

/** Compute the reference HMAC the way node:crypto does, independent of impl. */
function referenceHmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Stand up an HTTP receiver on 127.0.0.1 with a port-0 (ephemeral) bind.
 * `statusSequence` is the status code returned per request; the last entry is
 * reused once exhausted. Resolves null if the socket cannot bind (skip).
 */
async function startReceiver(statusSequence: number[] = [200]): Promise<Receiver | null> {
  const recorded: Recorded[] = [];
  let callIndex = 0;

  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      recorded.push({ method: req.method, headers: req.headers, body });
      const idx = Math.min(callIndex, statusSequence.length - 1);
      const status = statusSequence[idx];
      callIndex += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });

  const bound = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => resolve(true));
  });

  if (!bound) {
    return null;
  }

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/hook`;

  return {
    url,
    recorded,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

const ENV_KEYS = [
  "OCTORYN_SCOUT_WEBHOOK_SECRET",
  "OCTORYN_SCOUT_WEBHOOK_URLS",
  "OCTORYN_SCOUT_WEBHOOK_MAX_ATTEMPTS",
  "OCTORYN_SCOUT_WEBHOOK_TIMEOUT_MS",
  "OCTORYN_SCOUT_WEBHOOK_EVENTS"
];

let savedEnv: Record<string, string | undefined> = {};

function makeEvent(overrides: Partial<ScoutEvent> = {}): ScoutEvent {
  return {
    id: "evt_test_1",
    type: "scrape.completed",
    at: new Date().toISOString(),
    target: "https://example.test/page",
    data: { foo: "bar" },
    ...overrides
  };
}

/** Re-import the module after env changes so loadConfig() sees fresh values. */
async function freshModule(): Promise<typeof import("../src/events/webhooks.js")> {
  vi.resetModules();
  return import("../src/events/webhooks.js");
}

describe("signPayload", () => {
  it("is a stable 64-char hex HMAC-SHA256 matching node:crypto", async () => {
    const { signPayload } = await freshModule();
    const body = JSON.stringify({ event: makeEvent() });
    const secret = "top-secret-key";

    const sig = signPayload(body, secret);

    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(referenceHmac(body, secret));
  });

  it("is deterministic across calls", async () => {
    const { signPayload } = await freshModule();
    expect(signPayload("hello", "k")).toBe(signPayload("hello", "k"));
    expect(signPayload("hello", "k")).not.toBe(signPayload("hello", "k2"));
  });
});

describe("deliverEvent", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("POSTs JSON with event headers and a valid signature; records delivered", async () => {
    const receiver = await startReceiver([200]);
    if (!receiver) {
      console.warn("skipping: could not bind 127.0.0.1 socket");
      return;
    }
    try {
      const secret = "signing-secret-123";
      process.env.OCTORYN_SCOUT_WEBHOOK_SECRET = secret;

      const { deliverEvent, getWebhookDeliveries, resetWebhooks, signPayload } = await freshModule();
      resetWebhooks();

      const event = makeEvent({ type: "crawl.completed" });
      const results = await deliverEvent(event, [receiver.url]);

      expect(results).toHaveLength(1);
      const delivery = results[0];
      expect(delivery.status).toBe("delivered");
      expect(delivery.attempts).toBeGreaterThanOrEqual(1);
      expect(delivery.statusCode).toBe(200);
      expect(delivery.url).toBe(receiver.url);
      expect(delivery.eventType).toBe("crawl.completed");

      expect(receiver.recorded).toHaveLength(1);
      const req = receiver.recorded[0];
      expect(req.method).toBe("POST");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.headers["x-octoryn-event"]).toBe("crawl.completed");

      // Body is the JSON-encoded { event } envelope.
      const rawBody = req.body;
      expect(JSON.parse(rawBody)).toEqual({ event });

      // Signature header equals "sha256=" + signPayload(rawBody, secret).
      expect(req.headers["x-octoryn-signature"]).toBe(`sha256=${signPayload(rawBody, secret)}`);
      // And cross-checked against an independent HMAC computation.
      expect(req.headers["x-octoryn-signature"]).toBe(`sha256=${referenceHmac(rawBody, secret)}`);

      // Delivery log reflects the result.
      const logged = getWebhookDeliveries();
      expect(logged).toHaveLength(1);
      expect(logged[0].status).toBe("delivered");
      expect(logged[0].url).toBe(receiver.url);
    } finally {
      await receiver.close();
    }
  });

  it("omits the signature header when no secret is configured", async () => {
    const receiver = await startReceiver([200]);
    if (!receiver) {
      console.warn("skipping: could not bind 127.0.0.1 socket");
      return;
    }
    try {
      const { deliverEvent, resetWebhooks } = await freshModule();
      resetWebhooks();

      const results = await deliverEvent(makeEvent(), [receiver.url]);

      expect(results[0].status).toBe("delivered");
      expect(receiver.recorded[0].headers["x-octoryn-signature"]).toBeUndefined();
    } finally {
      await receiver.close();
    }
  });

  it("retries on 500 then succeeds with attempts >= 2", async () => {
    // First request 500s, second 200s. Keep maxAttempts small; backoff is
    // hardcoded at 200ms for the first retry, which is fine for one retry.
    const receiver = await startReceiver([500, 200]);
    if (!receiver) {
      console.warn("skipping: could not bind 127.0.0.1 socket");
      return;
    }
    try {
      process.env.OCTORYN_SCOUT_WEBHOOK_MAX_ATTEMPTS = "3";

      const { deliverEvent, getWebhookDeliveries, resetWebhooks } = await freshModule();
      resetWebhooks();

      const results = await deliverEvent(makeEvent(), [receiver.url]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("delivered");
      expect(results[0].attempts).toBeGreaterThanOrEqual(2);
      expect(results[0].statusCode).toBe(200);

      // Receiver saw at least two POSTs.
      expect(receiver.recorded.length).toBeGreaterThanOrEqual(2);
      for (const req of receiver.recorded) {
        expect(req.method).toBe("POST");
      }

      expect(getWebhookDeliveries()[0].status).toBe("delivered");
    } finally {
      await receiver.close();
    }
  }, 15_000);

  it("getWebhookDeliveries reflects the log and resetWebhooks clears it", async () => {
    const receiver = await startReceiver([200]);
    if (!receiver) {
      console.warn("skipping: could not bind 127.0.0.1 socket");
      return;
    }
    try {
      const { deliverEvent, getWebhookDeliveries, resetWebhooks } = await freshModule();
      resetWebhooks();
      expect(getWebhookDeliveries()).toHaveLength(0);

      await deliverEvent(makeEvent({ id: "evt_a" }), [receiver.url]);
      await deliverEvent(makeEvent({ id: "evt_b" }), [receiver.url]);

      const log = getWebhookDeliveries();
      expect(log).toHaveLength(2);
      // Newest-first.
      expect(log[0].eventId).toBe("evt_b");
      expect(log[1].eventId).toBe("evt_a");

      resetWebhooks();
      expect(getWebhookDeliveries()).toHaveLength(0);
    } finally {
      await receiver.close();
    }
  });

  it("returns an empty array when no target URLs are configured", async () => {
    const { deliverEvent, resetWebhooks } = await freshModule();
    resetWebhooks();
    const results = await deliverEvent(makeEvent(), []);
    expect(results).toEqual([]);
  });
});
