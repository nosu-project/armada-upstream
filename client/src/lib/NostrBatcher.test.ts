import type { NostrEvent, NostrFilter } from "@nostrify/types";
import type { NPool } from "@nostrify/nostrify";
import { describe, expect, it, vi } from "vitest";

import { NostrBatcher } from "@/lib/NostrBatcher";

function statusEvent(pubkey: string, content: string, d = "general"): NostrEvent {
  return {
    id: `${pubkey}-${d}`,
    pubkey,
    kind: 30315,
    created_at: 1000,
    content,
    tags: [["d", d]],
    sig: "sig",
  };
}

/** Minimal NPool stub that records the filters passed to `query`. */
function makePool(events: NostrEvent[]) {
  const calls: NostrFilter[][] = [];
  const pool = {
    query: vi.fn(async (filters: NostrFilter[]) => {
      calls.push(filters);
      // Emulate a relay: return events whose author is requested and d matches.
      const f = filters[0];
      const authors = new Set(f.authors ?? []);
      const dTags = new Set((f as Record<string, unknown>)["#d"] as string[] | undefined);
      return events.filter(
        (e) => authors.has(e.pubkey) && dTags.has(e.tags.find(([n]) => n === "d")?.[1] ?? ""),
      );
    }),
  } as unknown as NPool;
  return { pool, calls };
}

describe("NostrBatcher — NIP-38 status batching", () => {
  it("merges concurrent per-author kind-30315 queries into one REQ", async () => {
    const events = [
      statusEvent("alice", "🏖️ on vacation"),
      statusEvent("bob", "heads down"),
    ];
    const { pool, calls } = makePool(events);
    const batcher = new NostrBatcher(pool);

    // Three rows mount in the same tick: alice, bob, and carol (no status).
    const [a, b, c] = await Promise.all([
      batcher.query([{ kinds: [30315], authors: ["alice"], "#d": ["general"], limit: 1 }]),
      batcher.query([{ kinds: [30315], authors: ["bob"], "#d": ["general"], limit: 1 }]),
      batcher.query([{ kinds: [30315], authors: ["carol"], "#d": ["general"], limit: 1 }]),
    ]);

    // One combined REQ for all three authors.
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0][0].authors)).toEqual(new Set(["alice", "bob", "carol"]));

    // Each caller gets back only its own author's event.
    expect(a[0]?.content).toBe("🏖️ on vacation");
    expect(b[0]?.content).toBe("heads down");
    expect(c).toEqual([]);
  });

  it("keeps different d-tags (general vs music) in separate batches", async () => {
    const events = [
      statusEvent("alice", "working", "general"),
      statusEvent("alice", "lofi beats", "music"),
    ];
    const { pool, calls } = makePool(events);
    const batcher = new NostrBatcher(pool);

    const [general, music] = await Promise.all([
      batcher.query([{ kinds: [30315], authors: ["alice"], "#d": ["general"], limit: 1 }]),
      batcher.query([{ kinds: [30315], authors: ["alice"], "#d": ["music"], limit: 1 }]),
    ]);

    expect(calls).toHaveLength(2);
    expect(general[0]?.content).toBe("working");
    expect(music[0]?.content).toBe("lofi beats");
  });
});

function wrapEvent(id: string): NostrEvent {
  return { id, pubkey: "stream", kind: 1059, created_at: 1000, content: "", tags: [], sig: "sig" };
}

/**
 * A pool whose `relay(url)`/`group(urls)` handles record every `.query()` and
 * `.req()` call, so we can assert coalescing collapses identical concurrent
 * traffic onto one upstream request/subscription.
 */
function makeCoalescePool() {
  const queryCalls: { url: string; filters: NostrFilter[] }[] = [];
  const reqCalls: { url: string; filters: NostrFilter[] }[] = [];
  /** url → the async pusher feeding that relay's open `req` stream. */
  const feeders = new Map<string, (msg: NostrEvent) => void>();
  const closers = new Map<string, () => void>();

  const makeHandle = (url: string) => ({
    query: vi.fn(async (filters: NostrFilter[]) => {
      queryCalls.push({ url, filters });
      return [wrapEvent(`${url}-ev`)];
    }),
    req: vi.fn((filters: NostrFilter[]) => {
      reqCalls.push({ url, filters });
      const queue: NostrEvent[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      feeders.set(url, (msg) => {
        queue.push(msg);
        wake?.();
      });
      closers.set(url, () => {
        done = true;
        wake?.();
      });
      return (async function* () {
        for (;;) {
          while (queue.length > 0) yield ["EVENT", "sub", queue.shift()!];
          if (done) return;
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      })();
    }),
  });

  const pool = {
    relay: vi.fn((url: string) => makeHandle(url)),
    group: vi.fn((urls: string[]) => makeHandle(urls.join(","))),
  } as unknown as NPool;

  return { pool, queryCalls, reqCalls, feeders, closers };
}

describe("NostrBatcher — relay()/group() query coalescing", () => {
  it("collapses concurrent identical relay().query() onto one upstream REQ", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], authors: ["s"], since: 100 }];

    const [a, b, c] = await Promise.all([
      batcher.relay("wss://r1").query(filter),
      batcher.relay("wss://r1").query(filter),
      batcher.relay("wss://r1").query(filter),
    ]);

    const r1 = queryCalls.filter((c) => c.url === "wss://r1");
    expect(r1).toHaveLength(1); // one upstream call for three identical readers
    expect(a[0]?.id).toBe("wss://r1-ev");
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("does not coalesce different filters or different relays", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);

    await Promise.all([
      batcher.relay("wss://r1").query([{ kinds: [1059], since: 100 }]),
      batcher.relay("wss://r1").query([{ kinds: [1059], since: 200 }]), // different since
      batcher.relay("wss://r2").query([{ kinds: [1059], since: 100 }]), // different relay
    ]);

    expect(queryCalls).toHaveLength(3);
  });

  it("keys are order-insensitive (filter-entry and array order don't split a match)", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);

    await Promise.all([
      batcher.relay("wss://r1").query([{ kinds: [1, 2], authors: ["a", "b"] }]),
      batcher.relay("wss://r1").query([{ authors: ["b", "a"], kinds: [2, 1] }]),
    ]);

    expect(queryCalls.filter((c) => c.url === "wss://r1")).toHaveLength(1);
  });

  it("aborting one caller rejects only that caller, not the shared request", async () => {
    const { pool } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], since: 100 }];

    const ac = new AbortController();
    const aborted = batcher.relay("wss://r1").query(filter, { signal: ac.signal });
    const live = batcher.relay("wss://r1").query(filter);
    ac.abort(new Error("caller gone"));

    await expect(aborted).rejects.toThrow("caller gone");
    await expect(live).resolves.toEqual([wrapEvent("wss://r1-ev")]);
  });

  it("a fresh query after the shared one settled opens a new upstream", async () => {
    const { pool, queryCalls } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], since: 100 }];

    await batcher.relay("wss://r1").query(filter);
    await batcher.relay("wss://r1").query(filter);

    expect(queryCalls.filter((c) => c.url === "wss://r1")).toHaveLength(2);
  });
});

describe("NostrBatcher — relay()/group() req multiplexing", () => {
  it("fans one upstream subscription out to concurrent identical subscribers", async () => {
    const { pool, reqCalls, feeders } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], authors: ["s"], since: 100 }];

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const got1: string[] = [];
    const got2: string[] = [];

    const drain = (stream: AsyncIterable<unknown>, out: string[]) =>
      (async () => {
        for await (const msg of stream) {
          const m = msg as [string, string, NostrEvent];
          if (m[0] === "EVENT") out.push(m[2].id);
        }
      })();

    const p1 = drain(batcher.relay("wss://r1").req(filter, { signal: ac1.signal }), got1);
    const p2 = drain(batcher.relay("wss://r1").req(filter, { signal: ac2.signal }), got2);

    // Let both subscribers attach before the upstream emits.
    await new Promise((r) => setTimeout(r, 0));
    expect(reqCalls.filter((c) => c.url === "wss://r1")).toHaveLength(1);

    feeders.get("wss://r1")!(wrapEvent("m1"));
    await new Promise((r) => setTimeout(r, 0));

    ac1.abort();
    ac2.abort();
    await Promise.all([p1, p2]);

    expect(got1).toEqual(["m1"]);
    expect(got2).toEqual(["m1"]);
  });

  it("tears down the upstream when the last subscriber detaches, reopening for a new one", async () => {
    const { pool, reqCalls, feeders } = makeCoalescePool();
    const batcher = new NostrBatcher(pool);
    const filter = [{ kinds: [1059], since: 100 }];

    const drainOnce = async (signal: AbortSignal) => {
      for await (const _msg of batcher.relay("wss://r1").req(filter, { signal })) {
        void _msg;
      }
    };

    const ac1 = new AbortController();
    const p1 = drainOnce(ac1.signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(reqCalls).toHaveLength(1);
    feeders.get("wss://r1"); // upstream open
    ac1.abort();
    await p1;

    // New subscriber after the last one left → a fresh upstream REQ.
    const ac2 = new AbortController();
    const p2 = drainOnce(ac2.signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(reqCalls).toHaveLength(2);
    ac2.abort();
    await p2;
  });
});

