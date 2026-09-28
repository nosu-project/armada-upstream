import { beforeEach, describe, expect, it } from "vitest";

import {
  carryForwardWatches,
  loadLastPushSet,
  NAPP_LIMITS,
  saveLastPushSet,
  splitFilter,
  toNappSubscriptions,
  type PushWatch,
} from "@/lib/nappPush";

const hex = (n: number) => n.toString(16).padStart(64, "0");

const groups = (relay: string, ids: string[]): PushWatch => ({
  id: `armada-groups-${relay}`,
  relays: [relay],
  filter: { kinds: [9], "#h": ids },
});
const dm17: PushWatch = {
  id: "armada-dm17",
  relays: ["wss://dm-b", "wss://dm-a"],
  filter: { kinds: [1059], "#p": [hex(1)] },
};
const concord = (relays: string[], authors: string[]): PushWatch => ({
  id: `armada-c2-${relays.join()}`,
  relays,
  filter: { kinds: [1059], authors },
});

beforeEach(() => localStorage.clear());

describe("splitFilter", () => {
  it("leaves a filter within the limit alone", () => {
    expect(splitFilter({ kinds: [1], authors: [hex(1)] }, 2)).toEqual([{ kinds: [1], authors: [hex(1)] }]);
  });

  it("slices every over-long list, keeping the rest of the filter on each slice", () => {
    const split = splitFilter({ kinds: [1059], authors: [hex(1), hex(2), hex(3)], "#t": ["a", "b", "c"] }, 2);
    expect(split).toHaveLength(4);
    for (const filter of split) {
      expect(filter.kinds).toEqual([1059]);
      expect(filter.authors!.length).toBeLessThanOrEqual(2);
      expect(filter["#t"]!.length).toBeLessThanOrEqual(2);
    }
    // Every author is still paired with every tag value.
    const pairs = split.flatMap((f) => f.authors!.flatMap((a) => f["#t"]!.map((t) => `${a}/${t}`)));
    expect(new Set(pairs).size).toBe(9);
  });
});

describe("toNappSubscriptions", () => {
  it("shares a subscription between watches on the same relays", () => {
    const { subscriptions, dropped } = toNappSubscriptions([
      groups("wss://g", ["a"]),
      { id: "armada-groups-directed-g", relays: ["wss://g"], filter: { kinds: [7], "#h": ["a"] } },
      dm17,
    ], NAPP_LIMITS);
    expect(dropped).toBe(0);
    expect(subscriptions).toEqual([
      { relays: ["wss://dm-a", "wss://dm-b"], filters: [dm17.filter] },
      { relays: ["wss://g"], filters: [{ kinds: [9], "#h": ["a"] }, { kinds: [7], "#h": ["a"] }] },
    ]);
  });

  it("spreads long relay sets and filter lists over several subscriptions", () => {
    const relays = Array.from({ length: 12 }, (_, i) => `wss://r${String(i).padStart(2, "0")}`);
    const authors = Array.from({ length: 1100 }, (_, i) => hex(i));
    const { subscriptions } = toNappSubscriptions([concord(relays, authors)], NAPP_LIMITS);
    // 12 relays → 2 relay chunks; 1100 authors → 3 filters.
    expect(subscriptions).toHaveLength(2);
    for (const sub of subscriptions) {
      expect(sub.relays.length).toBeLessThanOrEqual(10);
      expect(sub.filters).toHaveLength(3);
      for (const filter of sub.filters) expect(filter.authors!.length).toBeLessThanOrEqual(500);
    }
  });

  it("drops groups before direct messages past the ceiling", () => {
    const many = Array.from({ length: 12 }, (_, i) => groups(`wss://g${String(i).padStart(2, "0")}`, ["x"]));
    const { subscriptions, dropped } = toNappSubscriptions([...many, dm17], NAPP_LIMITS);
    expect(subscriptions).toHaveLength(10);
    expect(dropped).toBe(3);
    expect(subscriptions[0].filters).toEqual([dm17.filter]);
  });

  it("skips a watch with no relays", () => {
    expect(toNappSubscriptions([{ ...dm17, relays: [] }], NAPP_LIMITS).subscriptions).toEqual([]);
  });
});

describe("carryForwardWatches", () => {
  const ready = { groups: true, dm: true, concord: true };

  it("is exactly the snapshot when every plane is ready", () => {
    expect(carryForwardWatches([dm17], [groups("wss://g", ["a"])], ready)).toEqual([dm17]);
  });

  it("keeps the last-set watches of a plane that has not loaded", () => {
    const old = groups("wss://g", ["a"]);
    const oldConcord = concord(["wss://c"], [hex(9)]);
    expect(carryForwardWatches([dm17], [old, oldConcord], { ...ready, groups: false }))
      .toEqual([dm17, old]);
  });

  it("prefers the snapshot's version of a watch it already has", () => {
    const fresh = groups("wss://g", ["a", "b"]);
    const stale = groups("wss://g", ["a"]);
    expect(carryForwardWatches([fresh], [stale], { ...ready, groups: false })).toEqual([fresh]);
  });
});

describe("the last set", () => {
  it("is carried only for the account that set it", () => {
    saveLastPushSet(hex(1), [dm17]);
    expect(loadLastPushSet(hex(1))).toEqual([dm17]);
    expect(loadLastPushSet(hex(2))).toEqual([]);
  });
});
