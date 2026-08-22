import { describe, expect, it } from "vitest";

import { buildDmActivityItems } from "@/hooks/useDmActivity";

const SELF = "0".repeat(64);
const ALICE = "1".repeat(64);
const BOB = "2".repeat(64);
const STRANGER = "3".repeat(64);

describe("buildDmActivityItems", () => {
  it("merges transports, keeps known groups, orders by recency, and applies read state", () => {
    const items = buildDmActivityItems(
      [
        {
          peer: ALICE,
          latest: { id: "legacy-alice", created_at: 20, pubkey: ALICE },
          mine: true,
        },
        {
          peer: STRANGER,
          latest: { id: "legacy-request", created_at: 50, pubkey: STRANGER },
          mine: false,
        },
      ],
      [
        {
          key: ALICE,
          peers: [ALICE],
          latest: { rumorId: "modern-alice", createdAt: 30, author: SELF, content: "sent" },
          mine: true,
        },
        {
          key: `${ALICE},${BOB}`,
          peers: [ALICE, BOB],
          latest: { rumorId: "group", createdAt: 40, author: BOB, content: "group update" },
          mine: true,
        },
        {
          key: `${ALICE},${STRANGER}`,
          peers: [ALICE, STRANGER],
          latest: { rumorId: "group-request", createdAt: 60, author: STRANGER, content: "nope" },
          mine: false,
        },
      ],
      { [ALICE]: "old preview" },
      {
        self: SELF,
        isKnown: (peer) => peer !== STRANGER,
        getLastRead: (key) => key === `dm:${ALICE},${BOB}` ? 35 : 0,
        unreadCounts: { [`${ALICE},${BOB}`]: 4 },
      },
    );

    expect(items.map((item) => item.key)).toEqual([`${ALICE},${BOB}`, ALICE]);
    expect(items[0]).toMatchObject({
      eventId: "group",
      author: BOB,
      content: "group update",
      unreadCount: 4,
      unread: true,
    });
    expect(items[1]).toMatchObject({
      eventId: "modern-alice",
      author: SELF,
      content: "sent",
      unreadCount: 0,
      unread: false,
    });
  });

  it("lets legacy win an exact timestamp tie and uses its decrypted preview", () => {
    const [item] = buildDmActivityItems(
      [{
        peer: ALICE,
        latest: { id: "legacy", created_at: 10, pubkey: ALICE },
        mine: true,
      }],
      [{
        key: ALICE,
        peers: [ALICE],
        latest: { rumorId: "modern", createdAt: 10, author: SELF, content: "modern" },
        mine: true,
      }],
      { [ALICE]: "legacy preview" },
      {
        self: SELF,
        isKnown: () => true,
        getLastRead: () => 10,
        // A stale asynchronous count must never resurrect a head whose shared
        // read stamp already reached its latest message.
        unreadCounts: { [ALICE]: 8 },
      },
    );

    expect(item).toMatchObject({
      eventId: "legacy",
      author: ALICE,
      content: "legacy preview",
      unreadCount: 0,
      unread: false,
    });
  });
});
