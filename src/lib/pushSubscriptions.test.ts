import { describe, expect, it } from "vitest";

import { buildPushSubscriptions, type PushSubscriptionInput } from "@/lib/pushSubscriptions";
import { DEFAULT_PUSH_PREFS } from "@/hooks/usePushNotifications";

const ME = "me".padEnd(64, "0");

function baseInput(overrides: Partial<PushSubscriptionInput> = {}): PushSubscriptionInput {
  return {
    pubkey: ME,
    relayUrls: [],
    groupIds: [],
    mentionOnlyGroupIds: [],
    prefs: { ...DEFAULT_PUSH_PREFS },
    dmRelays: [],
    dmFollows: [],
    concordV1: [],
    concordV2: [],
    ...overrides,
  };
}

function byId(specs: ReturnType<typeof buildPushSubscriptions>) {
  return new Map(specs.map((s) => [s.id, s]));
}

describe("buildPushSubscriptions", () => {
  it("returns nothing when there is nothing to watch", () => {
    expect(buildPushSubscriptions(baseInput())).toEqual([]);
  });

  it("splits group all-messages from directed messages", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({ relayUrls: ["wss://r"], groupIds: ["g1", "g2"] }),
      ),
    );
    const all = specs.get("armada-groups")!;
    expect(all.filter.kinds).toEqual([9]);
    expect(all.filter["#h"]).toEqual(["g1", "g2"]);
    expect(all.filter["#p"]).toBeUndefined();
    expect(all.notification.data.scope).toBe("group");

    const directed = specs.get("armada-groups-mention")!;
    expect(directed.filter["#p"]).toEqual([ME]);
    expect(directed.filter["#h"]).toEqual(["g1", "g2"]);
    expect(directed.filter.kinds).toEqual([9, 1111, 7]);
  });

  it("excludes a mentions-only group from the all-messages filter", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          relayUrls: ["wss://r"],
          groupIds: ["g1", "g2"],
          mentionOnlyGroupIds: ["g2"],
        }),
      ),
    );
    expect(specs.get("armada-groups")!.filter["#h"]).toEqual(["g1"]);
    // The directed filter still covers both (a mention in g2 must wake).
    expect(specs.get("armada-groups-mention")!.filter["#h"]).toEqual(["g1", "g2"]);
  });

  it("drops the all-messages filter when allGroupMessages is off", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          relayUrls: ["wss://r"],
          groupIds: ["g1"],
          prefs: { ...DEFAULT_PUSH_PREFS, allGroupMessages: false },
        }),
      ),
    );
    expect(specs.has("armada-groups")).toBe(false);
    expect(specs.has("armada-groups-mention")).toBe(true);
  });

  it("gates directed kinds by per-type prefs", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          relayUrls: ["wss://r"],
          groupIds: ["g1"],
          prefs: { ...DEFAULT_PUSH_PREFS, reactions: false, replies: false },
        }),
      ),
    );
    expect(specs.get("armada-groups-mention")!.filter.kinds).toEqual([9]);
  });

  it("omits the directed filter entirely when all its kinds are off", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          relayUrls: ["wss://r"],
          groupIds: ["g1"],
          prefs: {
            ...DEFAULT_PUSH_PREFS,
            mentions: false,
            replies: false,
            reactions: false,
          },
        }),
      ),
    );
    expect(specs.has("armada-groups-mention")).toBe(false);
  });

  it("scopes NIP-04 DMs to the follow set (friends-only)", () => {
    const withFollows = byId(
      buildPushSubscriptions(
        baseInput({ dmRelays: ["wss://dm"], dmFollows: ["bob", "amy"] }),
      ),
    );
    const dm = withFollows.get("armada-dm")!;
    expect(dm.filter).toEqual({ kinds: [4], "#p": [ME], authors: ["amy", "bob"] });

    // No follows ⇒ no DM subscription (mirrors native's friends-only scoping).
    const noFollows = byId(buildPushSubscriptions(baseInput({ dmRelays: ["wss://dm"] })));
    expect(noFollows.has("armada-dm")).toBe(false);
  });

  it("respects the directMessages pref", () => {
    const specs = buildPushSubscriptions(
      baseInput({
        dmRelays: ["wss://dm"],
        dmFollows: ["bob"],
        prefs: { ...DEFAULT_PUSH_PREFS, directMessages: false },
      }),
    );
    expect(specs.some((s) => s.id.startsWith("armada-dm"))).toBe(false);
  });

  it("merges Concord V1 channels that share a relay set into one #z filter", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          concordV1: [
            { relays: ["wss://c"], zs: ["z1"], keys: [], communityId: "c", communityName: "", channelName: "" },
            { relays: ["wss://c"], zs: ["z2"], keys: [], communityId: "c", communityName: "", channelName: "" },
          ],
        }),
      ),
    );
    const c1 = [...specs.values()].filter((s) => s.id.startsWith("armada-c1-"));
    expect(c1).toHaveLength(1);
    expect(c1[0].filter).toEqual({ kinds: [3300], "#z": ["z1", "z2"] });
  });

  it("splits Concord V1 channels on different relay sets", () => {
    const specs = buildPushSubscriptions(
      baseInput({
        concordV1: [
          { relays: ["wss://a"], zs: ["z1"], keys: [], communityId: "c", communityName: "", channelName: "" },
          { relays: ["wss://b"], zs: ["z2"], keys: [], communityId: "c", communityName: "", channelName: "" },
        ],
      }),
    );
    expect(specs.filter((s) => s.id.startsWith("armada-c1-"))).toHaveLength(2);
  });

  it("maps Concord V2 streams to a kind-1059 authors filter", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          concordV2: [
            {
              relays: ["wss://c"],
              communityId: "c",
              communityName: "",
              channelId: "ch",
              channelName: "",
              streams: [
                { pk: "s2", convKey: "k", epoch: "1" },
                { pk: "s1", convKey: "k", epoch: "0" },
              ],
              gitAttachments: [],
            },
          ],
        }),
      ),
    );
    const c2 = [...specs.values()].find((s) => s.id.startsWith("armada-c2-"))!;
    expect(c2.filter).toEqual({ kinds: [1059], authors: ["s1", "s2"] });
  });

  it("is deterministic under reordered inputs", () => {
    const a = buildPushSubscriptions(
      baseInput({ relayUrls: ["wss://r2", "wss://r1"], groupIds: ["g2", "g1"] }),
    );
    const b = buildPushSubscriptions(
      baseInput({ relayUrls: ["wss://r1", "wss://r2"], groupIds: ["g1", "g2"] }),
    );
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
