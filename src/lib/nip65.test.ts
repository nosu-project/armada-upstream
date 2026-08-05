import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import {
  buildRelayListTags,
  discoverRelayList,
  KIND_RELAY_LIST,
  MAX_RELAY_LIST_RELAYS,
  newestRelayList,
  parseRelayList,
  publishRelayListEvent,
  queryExplicitRelays,
} from "@/lib/nip65";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

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
