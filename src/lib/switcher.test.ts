import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { buildDmSwitcherEntries, focusMessageRoute } from "@/lib/switcher";

const alice = "a".repeat(64);
const bob = "b".repeat(64);
const carol = "c".repeat(64);

describe("focusMessageRoute", () => {
  it("focuses a Concord timeline message", () => {
    expect(focusMessageRoute("/c/community/channel", "older-message"))
      .toBe("/c/community/channel/m/older-message");
  });

  it("focuses a Concord reply inside its thread", () => {
    expect(focusMessageRoute("/c/community/channel", "reply", "thread-root"))
      .toBe("/c/community/channel/t/thread-root/m/reply");
  });

  it("focuses NIP-29 and DM message results", () => {
    expect(focusMessageRoute("/s/relay.example/group", "event-id"))
      .toBe("/s/relay.example/group/m/event-id");
    expect(focusMessageRoute("/dm/npub1peer", "rumor-id"))
      .toBe("/dm/npub1peer/m/rumor-id");
  });
});

describe("buildDmSwitcherEntries", () => {
  it("merges legacy and NIP-17 copies of a 1:1 without losing participation", () => {
    const entries = buildDmSwitcherEntries(
      [{ peer: alice, latest: { id: "legacy", created_at: 20 }, mine: false }],
      [
        {
          key: alice,
          peers: [alice],
          latest: { rumorId: "modern", createdAt: 10 },
          mine: true,
        },
      ],
      { isKnown: () => true },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: alice, peers: [alice], createdAt: 20, mine: true });
    expect(entries[0].route).toBe(`/dm/${nip19.npubEncode(alice)}`);
  });

  it("keeps group identity and routes the whole participant set", () => {
    const key = [alice, bob].join(",");
    const [entry] = buildDmSwitcherEntries(
      [],
      [
        {
          key,
          peers: [alice, bob],
          latest: { rumorId: "group", createdAt: 30 },
          mine: true,
        },
      ],
      { isKnown: () => true },
    );

    expect(entry.key).toBe(key);
    expect(entry.peers).toEqual([alice, bob]);
    expect(entry.route).toBe(`/dm/${nip19.npubEncode(alice)},${nip19.npubEncode(bob)}`);
  });

  it("keeps a group in requests when even one participant is unknown", () => {
    const key = [alice, bob].join(",");
    const entries = buildDmSwitcherEntries(
      [],
      [
        {
          key,
          peers: [alice, bob],
          latest: { rumorId: "group-request", createdAt: 30 },
          mine: false,
        },
      ],
      { isKnown: (peer) => peer === alice },
    );

    expect(entries).toEqual([]);
  });

  it("hides requests while retaining deliberate empty destinations and Note to Self", () => {
    const entries = buildDmSwitcherEntries(
      [],
      [
        {
          key: bob,
          peers: [bob],
          latest: { rumorId: "request", createdAt: 40 },
          mine: false,
        },
      ],
      {
        self: carol,
        started: [alice],
        pinned: [alice],
        isKnown: () => false,
      },
    );

    expect(entries.map((entry) => entry.key)).toEqual([alice, carol]);
    expect(entries.find((entry) => entry.key === bob)).toBeUndefined();
  });

  it("does not resurrect a missing conversation from a stale pin", () => {
    const entries = buildDmSwitcherEntries([], [], {
      pinned: [alice],
      isKnown: () => true,
    });

    expect(entries).toEqual([]);
  });

  it("does not promote a real request through a lingering started marker", () => {
    const entries = buildDmSwitcherEntries(
      [{ peer: bob, latest: { id: "request", created_at: 40 }, mine: false }],
      [],
      {
        started: [bob],
        isKnown: () => false,
      },
    );

    expect(entries).toEqual([]);
  });
});
