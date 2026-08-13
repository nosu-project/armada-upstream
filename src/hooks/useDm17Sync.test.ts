import { describe, expect, it, vi } from "vitest";

import { dm17InboxFilter, queryWrapsPerRelay } from "@/hooks/useDm17";

import type { NostrEvent } from "@nostrify/nostrify";

const event = (id: string, createdAt: number): NostrEvent => ({
  id: id.padEnd(64, "0"),
  pubkey: "1".repeat(64),
  created_at: createdAt,
  kind: 1059,
  tags: [["p", "2".repeat(64)]],
  content: "ciphertext",
  sig: "3".repeat(128),
});

describe("NIP-17 per-relay inbox queries", () => {
  it("keeps successful empty relays distinct from failed relays", async () => {
    const fastQuery = vi.fn().mockResolvedValue([]);
    const slowQuery = vi.fn().mockRejectedValue(new Error("timeout"));
    const nostr = {
      relay: (url: string) => ({ query: url.includes("fast") ? fastQuery : slowQuery }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://fast.example", "wss://slow.example"],
      { kinds: [1059], "#p": ["2".repeat(64)] },
      new AbortController().signal,
    );

    expect(result.pages).toEqual([{ url: "wss://fast.example", events: [] }]);
    expect(result.failed).toEqual(["wss://slow.example"]);
  });

  it("reports no successful pages when every relay fails", async () => {
    const nostr = {
      relay: () => ({ query: vi.fn().mockRejectedValue(new Error("offline")) }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://one.example", "wss://two.example"],
      { kinds: [1059] },
      new AbortController().signal,
    );

    expect(result.pages).toEqual([]);
    expect(result.failed).toEqual(["wss://one.example", "wss://two.example"]);
  });

  it("returns each relay's events without collapsing relay provenance", async () => {
    const first = event("a", 100);
    const second = event("b", 200);
    const nostr = {
      relay: (url: string) => ({
        query: vi.fn().mockResolvedValue(url.includes("one") ? [first] : [second]),
      }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://one.example", "wss://two.example"],
      (url) => ({ kinds: [1059], since: url.includes("one") ? 10 : 20 }),
      new AbortController().signal,
    );

    expect(result.pages).toEqual([
      { url: "wss://one.example", events: [first] },
      { url: "wss://two.example", events: [second] },
    ]);
  });
});

describe("NIP-17 per-relay inbox filters", () => {
  const self = "2".repeat(64);

  it("does not inherit a legacy global cursor for an unscanned relay", () => {
    const filter = dm17InboxFilter(
      self,
      { newest: 50_000, oldest: 1, exhausted: false },
      "wss://new.example",
      false,
    );

    expect(filter.since).toBeUndefined();
  });

  it("uses each relay's own cursor for narrow and full recovery windows", () => {
    const cursor = {
      newest: 50_000,
      oldest: 1,
      exhausted: false,
      relayNewest: {
        "wss://fast.example": 50_000,
        "wss://slow.example": 40_000,
      },
    };

    expect(dm17InboxFilter(self, cursor, "wss://fast.example", false).since).toBe(49_400);
    expect(dm17InboxFilter(self, cursor, "wss://slow.example", false).since).toBe(39_400);
    expect(dm17InboxFilter(self, cursor, "wss://fast.example", true).since).toBe(0);
  });
});
