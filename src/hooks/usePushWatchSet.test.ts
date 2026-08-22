import { describe, expect, it } from "vitest";

import {
  explicitDmNotificationLevels,
  policyAuthorizedPushSpecs,
  readyPlanePushSpecs,
} from "@/hooks/usePushWatchSet";

import type { PushSubscriptionSpec } from "@/lib/pushSubscriptions";

describe("explicitDmNotificationLevels", () => {
  it("preserves canonical group-DM keys without widening their participants", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(explicitDmNotificationLevels({
      [`dm:${a},${b}`]: "mentions",
      [`dm:${a}`]: "nothing",
      [`dm:${b},${a}`]: "all", // non-canonical order
      "dm:not-a-pubkey": "all",
      "wss://relay::group": "all",
    })).toEqual({
      [a]: "nothing",
      [`${a},${b}`]: "mentions",
    });
  });
});

describe("policyAuthorizedPushSpecs", () => {
  it("withholds a fresh default-derived watch while NIP-78 authority is unavailable", () => {
    const broadDefault = [{
      id: "armada-dm17",
      relays: ["wss://dm.example"],
      filter: { kinds: [1059], "#p": ["a".repeat(64)] },
      notification: {
        title: "New message",
        body: "New direct message",
        data: { scope: "dm" as const, relays: ["wss://dm.example"] },
      },
    }];
    expect(policyAuthorizedPushSpecs(false, broadDefault)).toEqual([]);
    expect(policyAuthorizedPushSpecs(true, broadDefault)).toBe(broadDefault);
  });
});

describe("readyPlanePushSpecs", () => {
  const spec = (id: string): PushSubscriptionSpec => ({
    id,
    relays: ["wss://relay.example"],
    filter: { kinds: [1059] },
    notification: {
      title: "New message",
      body: "New message",
      data: { scope: "dm", relays: ["wss://relay.example"] },
    },
  });
  const all = [
    spec("armada-groups-relay"),
    spec("armada-dm17"),
    spec("armada-dm"),
    spec("armada-c2-relays"),
  ];

  it("keeps NIP-29 while the encrypted planes fail closed", () => {
    expect(readyPlanePushSpecs(all, false, false).map(({ id }) => id))
      .toEqual(["armada-groups-relay"]);
  });

  it("allows each encrypted plane independently", () => {
    expect(readyPlanePushSpecs(all, true, false).map(({ id }) => id))
      .toEqual(["armada-groups-relay", "armada-dm17", "armada-dm"]);
    expect(readyPlanePushSpecs(all, false, true).map(({ id }) => id))
      .toEqual(["armada-groups-relay", "armada-c2-relays"]);
  });
});
