import { describe, expect, it } from "vitest";

import { fetchCreatorDmRelays } from "@/lib/creatorRelays";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

const PK = "a".repeat(64);

function dmRelayList(tags: string[][], created_at = 1000): NostrEvent {
  return {
    id: `10050-${created_at}`.padEnd(64, "0").slice(0, 64),
    pubkey: PK,
    created_at,
    kind: 10050,
    tags,
    content: "",
    sig: "f".repeat(128),
  };
}

function poolOf(events: NostrEvent[]) {
  return {
    query: (_filters: NostrFilter[], _opts?: { signal?: AbortSignal }) => Promise.resolve(events),
  };
}

describe("fetchCreatorDmRelays", () => {
  it("returns the relay tags of the published DM relay list", async () => {
    const pool = poolOf([
      dmRelayList([
        ["relay", "wss://inbox.example.com"],
        ["relay", "ws://192.168.1.5:5577"],
      ]),
    ]);
    expect(await fetchCreatorDmRelays(pool, PK)).toEqual([
      "wss://inbox.example.com",
      "ws://192.168.1.5:5577",
    ]);
  });

  it("normalizes and dedupes relay URLs, skipping empty tags", async () => {
    const pool = poolOf([
      dmRelayList([
        ["relay", "wss://inbox.example.com/"],
        ["relay", "wss://inbox.example.com"],
        ["relay", ""],
        ["nonrelay", "wss://other.example.com"],
      ]),
    ]);
    expect(await fetchCreatorDmRelays(pool, PK)).toEqual(["wss://inbox.example.com"]);
  });

  it("uses the newest DM relay list when several arrive", async () => {
    const pool = poolOf([
      dmRelayList([["relay", "wss://old.example.com"]], 1000),
      dmRelayList([["relay", "wss://new.example.com"]], 2000),
    ]);
    expect(await fetchCreatorDmRelays(pool, PK)).toEqual(["wss://new.example.com"]);
  });

  it("returns [] when no DM relay list is published", async () => {
    expect(await fetchCreatorDmRelays(poolOf([]), PK)).toEqual([]);
  });

  it("returns [] when the query fails", async () => {
    const pool = { query: () => Promise.reject(new Error("relay unreachable")) };
    expect(await fetchCreatorDmRelays(pool, PK)).toEqual([]);
  });
});
