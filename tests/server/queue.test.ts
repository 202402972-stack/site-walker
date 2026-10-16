// Queue behavior (plan §6/§8.1): concurrency 1, FIFO drain, 10 jobs/hour/session.
import { describe, it, expect, vi, afterEach } from "vitest";
import { isBusy, queueDepth, hourlyAllowed, recordEnqueue, enqueue } from "../../server/jobs/queue.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("queue (plan §8.1)", () => {
  it("runs one at a time, in FIFO order, and drains fully", async () => {
    const order: string[] = [];
    const first = enqueue("a", async () => { order.push("a"); });
    void enqueue("b", async () => { order.push("b"); });
    void enqueue("c", async () => { order.push("c"); });

    // 'a' is running, b and c are waiting.
    expect(isBusy()).toBe(true);
    expect(queueDepth()).toBe(2);

    await first; // resolves after the whole queue drains (concurrency 1)
    expect(order).toEqual(["a", "b", "c"]);
    expect(isBusy()).toBe(false);
    expect(queueDepth()).toBe(0);
  });

  it("allows 10 jobs/hour per session, then rate-limits, resets after the hour", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const session = "state-test-session";
    for (let i = 0; i < 10; i++) {
      expect(hourlyAllowed(session), `enqueue ${i + 1}`).toBe(true);
      recordEnqueue(session);
    }
    expect(hourlyAllowed(session)).toBe(false);
    vi.setSystemTime(1_700_000_000_000 + 3600 * 1000 + 1);
    expect(hourlyAllowed(session)).toBe(true);
  });
});
