import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { recordGroupActivity, recordTimelineEvent, recordUnreadActivity } from "./nip29Activity";

import type { NostrEvent } from "@nostrify/nostrify";

const RELAY = "wss://test.relay";
const USER = "u".repeat(64);

function msg(id: string, group: string, created_at: number): NostrEvent {
  return {
    id,
    kind: 9,
    pubkey: "a".repeat(64),
    created_at,
    content: `msg ${id}`,
    tags: [["h", group]],
    sig: "",
  };
}

function unreadKey(groupIds: string[], relay = RELAY) {
  return ["nip29", "unread", relay, [...groupIds].sort().join(","), USER] as const;
}

describe("recordUnreadActivity", () => {
  it("appends events only to unread caches watching the event's group", () => {
    const qc = new QueryClient();
    qc.setQueryData(unreadKey(["g1", "g2"]), []);
    qc.setQueryData(unreadKey(["g3"], "wss://other.relay"), []);

    recordUnreadActivity(qc, [msg("e1", "g1", 100)]);

    expect(qc.getQueryData(unreadKey(["g1", "g2"]))).toHaveLength(1);
    expect(qc.getQueryData(unreadKey(["g3"], "wss://other.relay"))).toHaveLength(0);
  });

  it("dedupes by event id (repeated delivery over multiple transports)", () => {
    const qc = new QueryClient();
    qc.setQueryData(unreadKey(["g1"]), []);

    recordUnreadActivity(qc, [msg("e1", "g1", 100)]);
    recordUnreadActivity(qc, [msg("e1", "g1", 100), msg("e2", "g1", 101)]);

    expect(qc.getQueryData(unreadKey(["g1"]))).toHaveLength(2);
  });

  it("caps the cache to the newest events", () => {
    const qc = new QueryClient();
    qc.setQueryData(unreadKey(["g1"]), []);

    const events = Array.from({ length: 700 }, (_, i) => msg(`e${i}`, "g1", i));
    recordUnreadActivity(qc, events);

    const cached = qc.getQueryData<NostrEvent[]>(unreadKey(["g1"]))!;
    expect(cached).toHaveLength(600);
    // Newest survive, oldest evicted.
    expect(cached.some((e) => e.id === "e699")).toBe(true);
    expect(cached.some((e) => e.id === "e0")).toBe(false);
  });

  it("ignores events without an #h tag", () => {
    const qc = new QueryClient();
    qc.setQueryData(unreadKey(["g1"]), []);
    const stray = { ...msg("e1", "g1", 100), tags: [] };

    recordUnreadActivity(qc, [stray]);

    expect(qc.getQueryData(unreadKey(["g1"]))).toHaveLength(0);
  });
});

describe("recordTimelineEvent", () => {
  it("inserts into existing timeline caches for the event's group only", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nip29", "messages", RELAY, "g1"], []);
    qc.setQueryData(["nip29", "messages", RELAY, "g2"], []);

    const touched = recordTimelineEvent(qc, msg("e1", "g1", 100));

    expect(touched).toBe(true);
    expect(qc.getQueryData(["nip29", "messages", RELAY, "g1"])).toHaveLength(1);
    expect(qc.getQueryData(["nip29", "messages", RELAY, "g2"])).toHaveLength(0);
  });

  it("is a no-op (not a cache creation) when the group has no timeline entry", () => {
    const qc = new QueryClient();

    const touched = recordTimelineEvent(qc, msg("e1", "g1", 100));

    expect(touched).toBe(false);
    expect(qc.getQueryCache().findAll({ queryKey: ["nip29", "messages"] })).toHaveLength(0);
  });

  it("keeps the timeline sorted oldest-first and deduped", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nip29", "messages", RELAY, "g1"], [msg("e2", "g1", 200)]);

    recordTimelineEvent(qc, msg("e1", "g1", 100));
    recordTimelineEvent(qc, msg("e1", "g1", 100));

    const cached = qc.getQueryData<NostrEvent[]>(["nip29", "messages", RELAY, "g1"])!;
    expect(cached.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("recordGroupActivity", () => {
  it("fans a batch into both the timeline and unread planes", () => {
    const qc = new QueryClient();
    qc.setQueryData(["nip29", "messages", RELAY, "g1"], []);
    qc.setQueryData(unreadKey(["g1"]), []);

    recordGroupActivity(qc, [msg("e1", "g1", 100), msg("e2", "g1", 101)]);

    expect(qc.getQueryData(["nip29", "messages", RELAY, "g1"])).toHaveLength(2);
    expect(qc.getQueryData(unreadKey(["g1"]))).toHaveLength(2);
  });
});
