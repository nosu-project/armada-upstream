import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools";
import type { UnsignedEvent } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import {
  buildRelayListTags,
  discoverRelayList,
  KIND_RELAY_LIST,
  MAX_RELAY_LIST_RELAYS,
  newerRelayListUpdate,
  newestRelayList,
  parseRelayList,
  publishRelayListEvent,
  queryExplicitRelays,
  queryExplicitRelaysWithStatus,
  relayListIsNewerThanMetadata,
  relayListVersionIsNewer,
} from "@/lib/nip65";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Lets one test hold the EC verify open across a macrotask, which is what the
 * real one does: `ecVerifyBatch` yields to the timer queue every 5ms of inline
 * work (`verifyPool`'s `INLINE_SLICE_MS`) and, when the pool is live, spans a
 * whole worker round trip. Pass-through otherwise.
 */
const ec = vi.hoisted(() => ({ stall: undefined as (() => Promise<void>) | undefined }));

vi.mock("@/lib/verifyPool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/verifyPool")>();
  return {
    ...actual,
    ecVerifyBatch: async (triples: Parameters<typeof actual.ecVerifyBatch>[0]) => {
      if (ec.stall) await ec.stall();
      return actual.ecVerifyBatch(triples);
    },
  };
});

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);

function relayList(tags: string[][], createdAt = 1_000): NostrEvent {
  return finalizeEvent({ kind: KIND_RELAY_LIST, content: "", tags, created_at: createdAt }, sk);
}

describe("NIP-65 relay lists", () => {
  it("normalizes URLs and merges duplicate read/write markers", () => {
    expect(parseRelayList(relayList([
      ["r", "WSS://ONE.EXAMPLE/", "read"],
      ["r", "wss://one.example", "write"],
      ["r", "two.example"],
      ["r", "https://not-a-relay.example"],
      ["r", "wss://ignored.example", "future-marker"],
    ]))).toEqual([
      { url: "wss://one.example", read: true, write: true },
      { url: "wss://two.example", read: true, write: true },
    ]);
  });

  it("caps the number of relay sockets a signed list can add", () => {
    const tags = Array.from({ length: MAX_RELAY_LIST_RELAYS + 5 }, (_, index) => [
      "r",
      `wss://relay-${index}.example`,
    ]);
    expect(parseRelayList(relayList(tags))).toHaveLength(MAX_RELAY_LIST_RELAYS);
  });

  it("builds canonical tags and drops disabled or invalid entries", () => {
    expect(buildRelayListTags([
      { url: "one.example/", read: true, write: true },
      { url: "wss://two.example", read: true, write: false },
      { url: "wss://three.example", read: false, write: true },
      { url: "https://invalid.example", read: true, write: true },
      { url: "wss://disabled.example", read: false, write: false },
    ])).toEqual([
      ["r", "wss://one.example"],
      ["r", "wss://two.example", "read"],
      ["r", "wss://three.example", "write"],
    ]);
  });

  it("uses NIP-01 replaceable ordering, including lowest id on a timestamp tie", () => {
    const a = relayList([["r", "wss://a.example"]], 2_000);
    const b = relayList([["r", "wss://b.example"]], 2_000);
    const older = relayList([["r", "wss://old.example"]], 1_999);
    const expected = [a, b].sort((left, right) => left.id.localeCompare(right.id))[0];
    expect(newestRelayList([older, a, b])?.id).toBe(expected.id);
    expect(relayListVersionIsNewer(expected, older)).toBe(true);
    expect(relayListVersionIsNewer(expected, expected === a ? b : a)).toBe(true);
    expect(relayListVersionIsNewer(older, expected)).toBe(false);
    expect(relayListVersionIsNewer(expected, expected)).toBe(false);
  });

  it("persists the equal-second winning id while allowing one legacy upgrade", () => {
    const lower = { created_at: 2_000, id: "0".repeat(64) };
    const higher = { created_at: 2_000, id: "f".repeat(64) };

    expect(relayListIsNewerThanMetadata(higher, { updatedAt: 2_000 })).toBe(true);
    expect(relayListIsNewerThanMetadata(lower, {
      updatedAt: 2_000,
      eventId: higher.id,
    })).toBe(true);
    expect(relayListIsNewerThanMetadata(higher, {
      updatedAt: 2_000,
      eventId: lower.id,
    })).toBe(false);
    expect(relayListIsNewerThanMetadata(lower, {
      updatedAt: 2_000,
      eventId: lower.id,
    })).toBe(false);
  });

  it("admits only signed, nonempty and newer live pointer updates", () => {
    const current = relayList([["r", "wss://current.example"]], 2_500);
    const newer = relayList([["r", "wss://new.example"]], 2_501);
    const empty = relayList([], 2_502);
    // JSON round-trip deliberately drops nostr-tools' cached Symbol(verified),
    // which `finalizeEvent` attaches and object spread would preserve.
    const invalid = { ...(JSON.parse(JSON.stringify(newer)) as NostrEvent), id: "0".repeat(64) };

    expect(newerRelayListUpdate(newer, current)?.relays).toEqual([
      { url: "wss://new.example", read: true, write: true },
    ]);
    expect(newerRelayListUpdate(current, newer)).toBeUndefined();
    expect(newerRelayListUpdate(empty, current)).toBeUndefined();
    expect(newerRelayListUpdate(invalid, current)).toBeUndefined();
  });

  it("discovers the newest valid list even when another indexer fails", async () => {
    const older = relayList([["r", "wss://old.example"]], 3_000);
    const latest = relayList([["r", "wss://home.example", "read"]], 3_001);
    const query = vi.fn(async (url: string, _filters: NostrFilter[]) => {
      if (url === "wss://offline.example") throw new Error("offline");
      return url === "wss://first.example" ? [older] : [latest];
    });
    const nostr = {
      relay: (url: string) => ({
        query: (filters: NostrFilter[]) => query(url, filters),
      }),
    };

    const found = await discoverRelayList(
      nostr,
      pubkey,
      ["wss://offline.example", "wss://first.example", "wss://second.example"],
      new AbortController().signal,
    );
    expect(found).toEqual({
      event: latest,
      relays: [{ url: "wss://home.example", read: true, write: false }],
    });
  });

  it("deduplicates valid events returned by multiple relays", async () => {
    const event = relayList([["r", "wss://one.example"]], 4_000);
    const invalid = { ...JSON.parse(JSON.stringify(event)), id: "0".repeat(64) } as NostrEvent;
    const nostr = {
      relay: () => ({ query: async () => [event, invalid] }),
    };
    const events = await queryExplicitRelays(
      nostr,
      ["wss://one.example", "wss://one.example/", "wss://two.example"],
      [{ kinds: [KIND_RELAY_LIST] }],
      new AbortController().signal,
    );
    expect(events).toEqual([event]);
  });

  it("drops a forged event whose id matches its content but whose signature is invalid", async () => {
    // id "0"*64 is caught before any EC verify (the hash gate). A forged event
    // must clear that gate — id recomputed to match the tampered content — so
    // that only the Schnorr verify (now the worker-pool batch) can reject it.
    const real = relayList([["r", "wss://real.example"]], 4_100);
    const tampered = { ...real, tags: [["r", "wss://attacker.example"]] };
    const forged = { ...tampered, id: getEventHash(tampered as UnsignedEvent) } as NostrEvent;
    const nostr = {
      relay: () => ({ query: async () => [real, forged] }),
    };
    const events = await queryExplicitRelays(
      nostr,
      ["wss://one.example"],
      [{ kinds: [KIND_RELAY_LIST] }],
      new AbortController().signal,
    );
    expect(events).toEqual([real]);
  });

  it("falls back to a pool-wide read when no explicit relays are given", async () => {
    const event = relayList([["r", "wss://one.example"]], 4_500);
    const relay = vi.fn(() => ({ query: async () => [] as NostrEvent[] }));
    const poolQuery = vi.fn(async () => [event]);
    const nostr = { relay, query: poolQuery };
    const events = await queryExplicitRelays(
      nostr,
      [],
      [{ kinds: [KIND_RELAY_LIST] }],
      new AbortController().signal,
    );
    expect(events).toEqual([event]);
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(relay).not.toHaveBeenCalled();
  });

  it("returns nothing (never a pool read) when explicit relays are provided", async () => {
    const poolQuery = vi.fn(async () => [relayList([["r", "wss://leak.example"]])]);
    const nostr = {
      relay: () => ({ query: async () => [] as NostrEvent[] }),
      query: poolQuery,
    };
    const events = await queryExplicitRelays(
      nostr,
      ["wss://one.example"],
      [{ kinds: [KIND_RELAY_LIST] }],
      new AbortController().signal,
    );
    expect(events).toEqual([]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("resolves after the grace window once one relay answers, leaving a laggard pending", async () => {
    vi.useFakeTimers();
    try {
      const fast = relayList([["r", "wss://fast.example"]], 6_000);
      const relay = (url: string) => ({
        query: () =>
          url === "wss://slow.example"
            ? new Promise<NostrEvent[]>((resolve) => {
                setTimeout(() => resolve([relayList([["r", "wss://slow.example"]], 6_001)]), 10_000);
              })
            : Promise.resolve([fast]),
      });
      const nostr = { relay };

      const promise = queryExplicitRelaysWithStatus(
        nostr,
        ["wss://fast.example", "wss://slow.example"],
        [{ kinds: [KIND_RELAY_LIST] }],
        new AbortController().signal,
        { graceMs: 1_500 },
      );
      // Let the fast relay settle, then run out the grace clock.
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await promise;

      expect(result.events).toEqual([fast]);
      expect(result.answered).toEqual(["wss://fast.example"]);
      // The still-in-flight relay is neither answered nor failed.
      expect(result.failed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without a grace window waits for every relay to settle", async () => {
    vi.useFakeTimers();
    try {
      const fast = relayList([["r", "wss://fast.example"]], 7_000);
      const slow = relayList([["r", "wss://slow.example"]], 7_001);
      const relay = (url: string) => ({
        query: () =>
          url === "wss://slow.example"
            ? new Promise<NostrEvent[]>((resolve) => {
                setTimeout(() => resolve([slow]), 10_000);
              })
            : Promise.resolve([fast]),
      });
      const nostr = { relay };

      const promise = queryExplicitRelaysWithStatus(
        nostr,
        ["wss://fast.example", "wss://slow.example"],
        [{ kinds: [KIND_RELAY_LIST] }],
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result.answered.sort()).toEqual(["wss://fast.example", "wss://slow.example"]);
      expect(result.failed).toEqual([]);
      expect(result.events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a laggard that answers during verification out of `answered`", async () => {
    // `answered` and the events must describe the same instant. Verification is
    // awaited between collecting the events and reading the settle states, and
    // `settleWithGrace` keeps mutating those states after it resolves — so a
    // laggard answering inside that window would be reported as having answered
    // while the events it returned were already left out. That pair reads as an
    // authoritative empty read from a relay we never actually heard.
    const fast = relayList([["r", "wss://fast.example"]], 8_000);
    const slow = relayList([["r", "wss://slow.example"]], 8_001);
    let arrive!: () => void;
    const laggard = new Promise<NostrEvent[]>((resolve) => {
      arrive = () => resolve([slow]);
    });
    const nostr = {
      relay: (url: string) => ({
        query: () => (url === "wss://slow.example" ? laggard : Promise.resolve([fast])),
      }),
    };
    ec.stall = async () => {
      arrive();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    try {
      const result = await queryExplicitRelaysWithStatus(
        nostr,
        ["wss://fast.example", "wss://slow.example"],
        [{ kinds: [KIND_RELAY_LIST] }],
        new AbortController().signal,
        { graceMs: 1 },
      );
      expect(result.events).toEqual([fast]);
      expect(result.answered).toEqual(["wss://fast.example"]);
      expect(result.failed).toEqual([]);
    } finally {
      ec.stall = undefined;
    }
  });

  it("fans the exact signed event to each relay and reports partial acceptance", async () => {
    const event = relayList([["r", "wss://home.example"]], 5_000);
    const delivered: Array<{ url: string; event: NostrEvent }> = [];
    const nostr = {
      relay: (url: string) => ({
        event: async (received: NostrEvent) => {
          delivered.push({ url, event: received });
          if (url === "wss://reject.example") throw new Error("blocked");
        },
      }),
    };
    const result = await publishRelayListEvent(
      nostr,
      event,
      ["home.example", "wss://reject.example", "wss://home.example/"],
      1_000,
    );
    expect(result).toEqual({
      accepted: ["wss://home.example"],
      rejected: ["wss://reject.example"],
    });
    expect(delivered).toEqual([
      { url: "wss://home.example", event },
      { url: "wss://reject.example", event },
    ]);
  });
});
