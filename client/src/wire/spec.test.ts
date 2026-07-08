import { describe, expect, it } from "vitest";

import { buildWireSpec } from "./spec";

import type { ConcordSub } from "@/concord-v1/lib/concordNotifications";
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
    isVoice: false,
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

  it("adds sent + friends-only received DM filters on the DM relays", () => {
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
      { kinds: [3300, 3305], "#z": ["z1", "z2", "z3"] },
    ]);
    expect(spec.v1ByZ.get("z1")).toBe("chan1");
    expect(spec.v1ByZ.get("z3")).toBe("chan2");
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
        { relays: ["wss://c.relay"], channel: chanA },
        { relays: ["wss://c.relay"], channel: chanB },
      ],
    });

    expect(spec.subs).toHaveLength(1);
    expect(spec.subs[0].filters).toEqual([
      { kinds: [1059], authors: ["pkA1", "pkA2", "pkB1"] },
    ]);
    expect(spec.v2ByPk.get("pkA2")).toBe(chanA);
    expect(spec.v2ByPk.get("pkB1")).toBe(chanB);
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
