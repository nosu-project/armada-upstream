import { describe, expect, it } from "vitest";

import { MAX_WRAP_BACKDATE_SECS } from "@/lib/nip17/protocol";

import { buildWireSpec, stampRoundSince } from "./spec";

import type { ConcordSub } from "@/concord-v1/lib/concordNotifications";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { ChannelV2 } from "@/concord-v2/lib/types";

const PUBKEY = "f".repeat(64);

function v2Channel(idByte: number, pks: string[]): ChannelV2 {
  const id = new Uint8Array(32).fill(idByte);
  const idHex = Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    id,
    idHex,
    name: "general",
    isPrivate: false,
    streams: pks.map((pk, i) => ({
      epoch: BigInt(i),
      group: { pk } as unknown as ChannelV2["streams"][number]["group"],
    })),
    current: { epoch: 0n, group: { pk: pks[0] } as unknown as ChannelV2["streams"][number]["group"] },
  } as ChannelV2;
}

describe("buildWireSpec", () => {
  it("builds one #h filter per NIP-29 host relay (relay = community)", () => {
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [
        { id: "g1", relay: "wss://a.relay" },
        { id: "g2", relay: "wss://a.relay/" }, // same relay, unnormalized
        { id: "g3", relay: "wss://b.relay" },
      ],
      dmRelays: [],
      dmFollows: [],
      concord1: [],
      concord2: [],
    });

    expect(spec.subs).toHaveLength(2);
    const a = spec.subs.find((s) => s.relay.startsWith("wss://a.relay"));
    const b = spec.subs.find((s) => s.relay.startsWith("wss://b.relay"));
    expect(a?.filters).toEqual([{ kinds: [9, 1068, 5], "#h": ["g1", "g2"] }]);
    expect(b?.filters).toEqual([{ kinds: [9, 1068, 5], "#h": ["g3"] }]);
  });

  it("adds sent + friends-only received DM filters plus the NIP-17 gift-wrap inbox on the DM relays", () => {
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: ["wss://dm.relay"],
      dmFollows: ["b".repeat(64), "a".repeat(64)],
      concord1: [],
      concord2: [],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([
      { kinds: [4], authors: [PUBKEY] },
      { kinds: [4], authors: ["a".repeat(64), "b".repeat(64)], "#p": [PUBKEY] },
      { kinds: [1059], "#p": [PUBKEY] },
    ]);
  });

  it("omits DM filters entirely when logged out", () => {
    const spec = buildWireSpec({
      pubkey: undefined,
      groups: [],
      dmRelays: ["wss://dm.relay"],
      dmFollows: ["a".repeat(64)],
      concord1: [],
      concord2: [],
    });
    expect(spec.subs).toHaveLength(0);
  });

  it("merges Concord V1 #z pseudonyms per community relay and maps z → channel", () => {
    const sub1: ConcordSub = {
      relays: ["wss://c.relay"],
      zs: ["z1", "z2"],
      keys: [
        { z: "z1", key: "k", channelId: "chan1", epoch: "1" },
        { z: "z2", key: "k", channelId: "chan1", epoch: "0" },
      ],
      communityId: "comm1",
      communityName: "Comm",
      channelName: "general",
    };
    const sub2: ConcordSub = { ...sub1, zs: ["z3"], keys: [{ z: "z3", key: "k", channelId: "chan2", epoch: "0" }], channelName: "random" };

    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord1: [sub1, sub2],
      concord2: [],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([
      { kinds: [3300, 3302, 3305, 3301], "#z": ["z1", "z2", "z3"] },
    ]);
    expect(spec.v1ByZ.get("z1")).toBe("chan1");
    expect(spec.v1ByZ.get("z3")).toBe("chan2");
  });

  it("holds a separate control-#z filter per relay and maps control z → community", () => {
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord1: [],
      concord1Control: [
        { relays: ["wss://c.relay"], z: "ctlZ1", communityId: "comm1" },
        { relays: ["wss://c.relay"], z: "ctlZ2", communityId: "comm2" },
      ],
      concord2: [],
    });

    expect(spec.subs).toHaveLength(1);
    // Control (3308) is its own filter, distinct from the message plane.
    expect(spec.subs[0].filters).toEqual([{ kinds: [3308], "#z": ["ctlZ1", "ctlZ2"] }]);
    expect(spec.v1CtlByZ.get("ctlZ1")).toBe("comm1");
    expect(spec.v1CtlByZ.get("ctlZ2")).toBe("comm2");
  });

  it("merges Concord V2 stream authors per community relay and maps pk → channel", () => {
    const chanA = v2Channel(1, ["pkA1", "pkA2"]);
    const chanB = v2Channel(2, ["pkB1"]);

    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord1: [],
      concord2: [
        { relays: ["wss://c.relay"], channel: chanA, communityIdHex: "commA" },
        { relays: ["wss://c.relay"], channel: chanB, communityIdHex: "commB" },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([
      { kinds: [1059], authors: ["pkA1", "pkA2", "pkB1"] },
    ]);
    expect(spec.v2ByPk.get("pkA2")).toBe(chanA);
    expect(spec.v2ByPk.get("pkB1")).toBe(chanB);
  });

  it("subscribes to Concord V2 control authors and maps control pk → community", () => {
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord1: [],
      concord2: [],
      concord2Control: [
        {
          relays: ["wss://c.relay"],
          idHex: "a".repeat(64),
          groups: [{ pk: "ctlA1" } as unknown as GroupKey, { pk: "ctlA2" } as unknown as GroupKey],
        },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([{ kinds: [1059], authors: ["ctlA1", "ctlA2"] }]);
    expect(spec.v2CtlByPk.get("ctlA1")?.idHex).toBe("a".repeat(64));
    expect(spec.v2CtlByPk.get("ctlA2")?.idHex).toBe("a".repeat(64));
  });

  it("keeps chat-wrap and control-wrap filters separate on the same relay", () => {
    const chanA = v2Channel(1, ["pkA1"]);
    const spec = buildWireSpec({
      pubkey: PUBKEY,
      groups: [],
      dmRelays: [],
      dmFollows: [],
      concord1: [],
      concord2: [{ relays: ["wss://c.relay"], channel: chanA, communityIdHex: "commA" }],
      concord2Control: [
        { relays: ["wss://c.relay"], idHex: "a".repeat(64), groups: [{ pk: "ctlA1" } as unknown as GroupKey] },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([
      { kinds: [1059], authors: ["pkA1"] },
      { kinds: [1059], authors: ["ctlA1"] },
    ]);
  });

  it("keeps the sig stable across input reordering (no needless resubscribes)", () => {
    const base = {
      pubkey: PUBKEY,
      dmRelays: [],
      dmFollows: [],
      concord1: [],
      concord2: [],
    };
    const a = buildWireSpec({ ...base, groups: [{ id: "g1", relay: "wss://a" }, { id: "g2", relay: "wss://a" }] });
    const b = buildWireSpec({ ...base, groups: [{ id: "g2", relay: "wss://a" }, { id: "g1", relay: "wss://a" }] });
    expect(a.sig).toBe(b.sig);
  });
});

describe("stampRoundSince", () => {
  const NOW = 1_800_000_000;
  const SINCE = NOW - 60; // a cursor-derived resume point

  it("stamps the cursor since onto every filter EXCEPT the NIP-17 wrap inbox", () => {
    const dm17 = buildWireSpec({
      pubkey: PUBKEY,
      groups: [{ id: "g1", relay: "wss://dm.relay" }],
      dmRelays: ["wss://dm.relay"],
      dmFollows: ["a".repeat(64)],
      concord1: [],
      concord2: [],
    });
    const stamped = stampRoundSince(dm17.subs[0].filters, SINCE, NOW);

    for (const f of stamped) {
      if (f.kinds?.length === 1 && f.kinds[0] === 1059 && !f.authors) {
        // A gift wrap's created_at is NIP-59-backdated up to 2 days, and relays
        // apply `since` to live events too — a cursor-derived since would filter
        // out virtually every LIVE wrap (the "DMs only arrive on the poll" lag).
        expect(f.since).toBeLessThanOrEqual(NOW - MAX_WRAP_BACKDATE_SECS);
        // The rewind replays stored wraps each round; the limit bounds it.
        expect(f.limit).toBeGreaterThan(0);
      } else {
        expect(f.since).toBe(SINCE);
        expect(f.limit).toBeUndefined();
      }
    }
    // Sanity: the set really contained both shapes.
    expect(stamped.some((f) => f.kinds?.[0] === 1059)).toBe(true);
    expect(stamped.some((f) => f.kinds?.[0] === 9)).toBe(true);
  });

  it("keeps the cursor since on a Concord V2 wrap filter (authors-scoped, real timestamps)", () => {
    const stamped = stampRoundSince([{ kinds: [1059], authors: ["pkA1"] }], SINCE, NOW);
    expect(stamped[0].since).toBe(SINCE);
    expect(stamped[0].limit).toBeUndefined();
  });

  it("takes the deeper of cursor since and the backdate rewind for the wrap filter", () => {
    const deepCursor = NOW - 6 * 24 * 60 * 60; // device off for days
    const stamped = stampRoundSince([{ kinds: [1059], "#p": [PUBKEY] }], deepCursor, NOW);
    expect(stamped[0].since).toBe(deepCursor);
  });
});
