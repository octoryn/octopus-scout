import { randomUUID } from "node:crypto";

import type { ScoutEvent, ScoutEventType } from "../types.js";

/**
 * Internal, in-process event bus.
 *
 * Best-effort by design: emitting an event and notifying subscribers must
 * NEVER throw or break the core pipeline. Subscriber callbacks are isolated
 * (one bad subscriber cannot affect others or the emitter) and async
 * subscribers are fired-and-forgotten.
 */

type EventHandler = (event: ScoutEvent) => void | Promise<void>;

/** Maximum number of events retained in the ring buffer. */
const MAX_BUFFER = 500;

/** Default number of events returned by {@link recentEvents}. */
const DEFAULT_RECENT_LIMIT = 100;

const subscribers = new Set<EventHandler>();

/**
 * Append-only ring buffer of recent events. Oldest entries are dropped once
 * the buffer exceeds {@link MAX_BUFFER}. Stored oldest-first; callers that
 * want newest-first use {@link recentEvents}.
 */
const buffer: ScoutEvent[] = [];

/**
 * Build a {@link ScoutEvent}, record it in the ring buffer, and synchronously
 * notify every subscriber. Returns the constructed event.
 *
 * Never throws. Each subscriber invocation is wrapped in try/catch; thrown
 * errors and rejected promises from subscribers are swallowed so that a faulty
 * subscriber cannot break event emission or the caller's pipeline.
 */
export function emitEvent(input: { type: ScoutEventType; target: string; data?: Record<string, unknown> }): ScoutEvent {
  const event: ScoutEvent = {
    id: randomUUID(),
    type: input.type,
    at: new Date().toISOString(),
    target: input.target,
    ...(input.data !== undefined ? { data: input.data } : {})
  };

  // Record before notifying so recentEvents() reflects the event even if a
  // subscriber re-enters the bus.
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) {
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }

  // Snapshot subscribers so a handler that subscribes/unsubscribes during
  // notification does not perturb this dispatch pass.
  for (const handler of [...subscribers]) {
    try {
      const result = handler(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {
          /* swallow async subscriber errors */
        });
      }
    } catch {
      /* swallow sync subscriber errors */
    }
  }

  return event;
}

/**
 * Register a subscriber. The handler is invoked synchronously (fire-and-forget
 * for async handlers) on every subsequent {@link emitEvent}. Returns an
 * idempotent unsubscribe function.
 */
export function onEvent(handler: EventHandler): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

/**
 * Return buffered events newest-first, optionally filtered by type.
 * Defaults to the most recent {@link DEFAULT_RECENT_LIMIT} events.
 */
export function recentEvents(opts?: { type?: ScoutEventType; limit?: number }): ScoutEvent[] {
  const limit = opts?.limit !== undefined && opts.limit >= 0 ? opts.limit : DEFAULT_RECENT_LIMIT;

  const result: ScoutEvent[] = [];
  for (let i = buffer.length - 1; i >= 0 && result.length < limit; i--) {
    const event = buffer[i];
    if (opts?.type !== undefined && event.type !== opts.type) {
      continue;
    }
    result.push(event);
  }
  return result;
}

/** Clear all subscribers and buffered events. Intended for tests. */
export function resetEventBus(): void {
  subscribers.clear();
  buffer.length = 0;
}
