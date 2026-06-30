import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { emitEvent, onEvent, recentEvents, resetEventBus } from "../src/events/eventBus.js";
import type { ScoutEvent } from "../src/types.js";

describe("eventBus", () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  it("delivers an emitted event to a subscriber", () => {
    const received: ScoutEvent[] = [];
    onEvent((event) => {
      received.push(event);
    });

    const emitted = emitEvent({
      type: "scrape.completed",
      target: "https://example.com"
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(emitted);
  });

  it("returns a ScoutEvent with id, ISO at, and given type/target/data", () => {
    const data = { count: 3, ok: true };
    const event = emitEvent({
      type: "crawl.completed",
      target: "https://example.com/site",
      data
    });

    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.type).toBe("crawl.completed");
    expect(event.target).toBe("https://example.com/site");
    expect(event.data).toEqual(data);

    // `at` is a valid ISO-8601 timestamp that round-trips.
    expect(typeof event.at).toBe("string");
    expect(new Date(event.at).toISOString()).toBe(event.at);
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });

  it("omits data when not provided", () => {
    const event = emitEvent({
      type: "job.failed",
      target: "worker-1"
    });

    expect(event.data).toBeUndefined();
  });

  it("generates a unique id per emitted event", () => {
    const a = emitEvent({ type: "job.failed", target: "a" });
    const b = emitEvent({ type: "job.failed", target: "b" });

    expect(a.id).not.toBe(b.id);
  });

  it("returns recent events newest-first", () => {
    emitEvent({ type: "scrape.completed", target: "first" });
    emitEvent({ type: "scrape.completed", target: "second" });
    emitEvent({ type: "scrape.completed", target: "third" });

    const recent = recentEvents();

    expect(recent.map((e) => e.target)).toEqual(["third", "second", "first"]);
  });

  it("filters recent events by type", () => {
    emitEvent({ type: "scrape.completed", target: "s1" });
    emitEvent({ type: "crawl.completed", target: "c1" });
    emitEvent({ type: "scrape.completed", target: "s2" });

    const scrapes = recentEvents({ type: "scrape.completed" });

    expect(scrapes.map((e) => e.target)).toEqual(["s2", "s1"]);
    expect(scrapes.every((e) => e.type === "scrape.completed")).toBe(true);
  });

  it("respects the limit option", () => {
    for (let i = 0; i < 5; i++) {
      emitEvent({ type: "scrape.completed", target: `t${i}` });
    }

    const limited = recentEvents({ limit: 2 });

    expect(limited).toHaveLength(2);
    expect(limited.map((e) => e.target)).toEqual(["t4", "t3"]);
  });

  it("does not break emitEvent when a subscriber throws", () => {
    const other = vi.fn();
    onEvent(() => {
      throw new Error("boom");
    });
    onEvent(other);

    let emitted: ScoutEvent | undefined;
    expect(() => {
      emitted = emitEvent({ type: "scrape.completed", target: "x" });
    }).not.toThrow();

    // Still returns the constructed event.
    expect(emitted).toBeDefined();
    expect(emitted?.target).toBe("x");
    // Other subscribers still fire despite the faulty one.
    expect(other).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledWith(emitted);
    // And the event is still recorded.
    expect(recentEvents()).toHaveLength(1);
  });

  it("swallows rejected promises from async subscribers", async () => {
    onEvent(async () => {
      throw new Error("async boom");
    });

    expect(() => {
      emitEvent({ type: "scrape.completed", target: "async" });
    }).not.toThrow();

    // Allow any microtasks to flush; no unhandled rejection should occur.
    await Promise.resolve();
    expect(recentEvents()).toHaveLength(1);
  });

  it("stops delivery after unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = onEvent(handler);

    emitEvent({ type: "scrape.completed", target: "before" });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitEvent({ type: "scrape.completed", target: "after" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe is idempotent", () => {
    const handler = vi.fn();
    const unsubscribe = onEvent(handler);
    unsubscribe();

    expect(() => unsubscribe()).not.toThrow();
    emitEvent({ type: "scrape.completed", target: "x" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("resetEventBus clears subscribers and buffer", () => {
    const handler = vi.fn();
    onEvent(handler);
    emitEvent({ type: "scrape.completed", target: "x" });
    expect(handler).toHaveBeenCalledTimes(1);

    resetEventBus();

    expect(recentEvents()).toHaveLength(0);
    emitEvent({ type: "scrape.completed", target: "y" });
    // Subscriber was cleared, so no further deliveries.
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
