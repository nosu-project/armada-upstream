/**
 * The behaviour these cover is the one `NPool.query` gets wrong, and it is the
 * reason a config change made on one device didn't reach another: a read that
 * gives up as soon as the FIRST relay answers, reported as if it were an
 * authoritative empty result.
 */
import { describe, expect, it } from "vitest";

import { newestOf, readToEose } from "./relayRead";

import type { NostrEvent, NostrFilter, NRelay } from "@nostrify/nostrify";

type Msg = ["EVENT", string, NostrEvent] | ["EOSE", string] | ["CLOSED", string, string];

function event(id: string, created_at: number): NostrEvent {
  return {
    id,
    created_at,
    kind: 30078,
    pubkey: "a".repeat(64),
    content: "",
    tags: [],
    sig: "0".repeat(128),
  };
}

/** Sleep that ends early on abort, the way a real subscription reacts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A relay that emits a scripted sequence of messages, each after a delay, and
 * that honours the abort signal the way NRelay1/NPool do (the iteration simply
 * ends). `eoseTimeout` is recorded so a test can assert we never ask for the
 * early-abort behaviour.
 */
function scriptedRelay(script: Array<{ afterMs: number; msg: Msg }>): {
  relay: NRelay;
  optsSeen: Array<Record<string, unknown> | undefined>;
} {
  const optsSeen: Array<Record<string, unknown> | undefined> = [];
  const relay = {
    async *req(_filters: NostrFilter[], opts?: { signal?: AbortSignal }) {
      optsSeen.push(opts as Record<string, unknown> | undefined);
      for (const step of script) {
        await sleep(step.afterMs, opts?.signal);
        if (opts?.signal?.aborted) return;
        yield step.msg;
      }
      // Nothing more scripted: block until aborted, like a live subscription.
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) return resolve();
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  } as unknown as NRelay;
  return { relay, optsSeen };
}

describe("readToEose", () => {
  it("waits for a slow relay instead of stopping at the first answer", async () => {
    // The shape of the bug: something answers immediately with nothing, and the
    // event we actually want shows up well after the pool's 300ms eoseTimeout.
    const { relay } = scriptedRelay([
      { afterMs: 350, msg: ["EVENT", "sub", event("late", 100)] },
      { afterMs: 0, msg: ["EOSE", "sub"] },
    ]);

    const result = await readToEose(relay, [{ kinds: [30078] }], { timeoutMs: 3000 });

    expect(result.events.map((e) => e.id)).toEqual(["late"]);
    expect(result.complete).toBe(true);
  });

  it("never passes an eoseTimeout, so NPool waits for every routed relay", async () => {
    const { relay, optsSeen } = scriptedRelay([{ afterMs: 0, msg: ["EOSE", "sub"] }]);

    await readToEose(relay, [{ kinds: [30078] }], { timeoutMs: 1000 });

    expect(optsSeen).toHaveLength(1);
    expect(optsSeen[0]).not.toHaveProperty("eoseTimeout");
  });

  it("reports complete on EOSE with no events — an authoritative absence", async () => {
    const { relay } = scriptedRelay([{ afterMs: 0, msg: ["EOSE", "sub"] }]);

    const result = await readToEose(relay, [{ kinds: [30078] }], { timeoutMs: 1000 });

    expect(result.events).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("reports incomplete when the budget expires before EOSE", async () => {
    // A relay that connects but never finishes answering — the just-resumed
    // phone. An empty result here must NOT read as "the user has no settings".
    const { relay } = scriptedRelay([{ afterMs: 5000, msg: ["EOSE", "sub"] }]);

    const result = await readToEose(relay, [{ kinds: [30078] }], { timeoutMs: 50 });

    expect(result.events).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it("keeps events received before the budget expired, still marked incomplete", async () => {
    const { relay } = scriptedRelay([
      { afterMs: 10, msg: ["EVENT", "sub", event("got-one", 5)] },
      { afterMs: 5000, msg: ["EOSE", "sub"] },
    ]);

    const result = await readToEose(relay, [{ kinds: [30078] }], { timeoutMs: 100 });

    expect(result.events.map((e) => e.id)).toEqual(["got-one"]);
    expect(result.complete).toBe(false);
  });

  it("treats CLOSED as an end, but not as a completed read", async () => {
    const { relay } = scriptedRelay([
      { afterMs: 0, msg: ["CLOSED", "sub", "auth-required: nope"] },
    ]);

    const result = await readToEose(relay, [{ kinds: [30078] }], { timeoutMs: 1000 });

    expect(result.complete).toBe(false);
  });

  it("does not throw when the relay errors", async () => {
    const relay = {
      // eslint-disable-next-line require-yield
      async *req() {
        throw new Error("socket died");
      },
    } as unknown as NRelay;

    await expect(readToEose(relay, [{ kinds: [30078] }], { timeoutMs: 100 })).resolves.toEqual({
      events: [],
      complete: false,
    });
  });

  it("honours a caller's signal alongside the budget", async () => {
    const { relay } = scriptedRelay([{ afterMs: 5000, msg: ["EOSE", "sub"] }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await readToEose(relay, [{ kinds: [30078] }], {
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    expect(result.complete).toBe(false);
  });
});

describe("newestOf", () => {
  it("picks the highest created_at", () => {
    expect(newestOf([event("a", 1), event("c", 3), event("b", 2)])?.id).toBe("c");
  });

  it("is undefined for an empty set", () => {
    expect(newestOf([])).toBeUndefined();
  });
});
