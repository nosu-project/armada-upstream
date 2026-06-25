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
