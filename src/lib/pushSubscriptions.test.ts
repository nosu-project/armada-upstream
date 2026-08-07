import { describe, expect, it } from "vitest";

import {
  buildPushSubscriptions,
  scopePushSubscriptionId,
  type PushSubscriptionInput,
} from "@/lib/pushSubscriptions";
import { DEFAULT_PUSH_PREFS } from "@/lib/pushPrefs";

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

  it("watches every addressed NIP-17 wrap, including unknown senders", () => {
    const specs = byId(
      buildPushSubscriptions(baseInput({ dmRelays: ["wss://two", "wss://one"] })),
    );
    const dm = specs.get("armada-dm17")!;
    expect(dm.relays).toEqual(["wss://one", "wss://two"]);
    expect(dm.filter).toEqual({ kinds: [1059], "#p": [ME] });
    expect(dm.notification.data).toEqual({
      scope: "dm",
      relays: ["wss://one", "wss://two"],
      url: "/dm",
    });
  });

  it("also scopes legacy NIP-04 DMs to the follow set (friends-only)", () => {
    const withFollows = byId(
      buildPushSubscriptions(
        baseInput({ dmRelays: ["wss://dm"], dmFollows: ["bob", "amy"] }),
      ),
    );
    const dm = withFollows.get("armada-dm")!;
    expect(dm.filter).toEqual({ kinds: [4], "#p": [ME], authors: ["amy", "bob"] });

    // No follows omits only the legacy subscription; modern NIP-17 DMs are
    // still watched because their wrap authors are ephemeral.
    const noFollows = byId(buildPushSubscriptions(baseInput({ dmRelays: ["wss://dm"] })));
    expect(noFollows.has("armada-dm")).toBe(false);
    expect(noFollows.has("armada-dm17")).toBe(true);
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
              timerSecs: 0,
              gitAttachments: [],
            },
          ],
        }),
      ),
    );
    const c2 = [...specs.values()].find((s) => s.id.startsWith("armada-c2-"))!;
    expect(c2.filter).toEqual({ kinds: [1059], authors: ["s1", "s2"] });
  });

  it("merges Concord channels that share a relay set into one authors filter", () => {
    const sub = (relays: string[], pk: string) => ({
      relays,
      communityId: "c",
      communityName: "",
      channelId: pk,
      channelName: "",
      streams: [{ pk, convKey: "k", epoch: "0" }],
      timerSecs: 0,
      gitAttachments: [],
    });
    const merged = buildPushSubscriptions(
      baseInput({ concordV2: [sub(["wss://c"], "s1"), sub(["wss://c"], "s2")] }),
    ).filter((s) => s.id.startsWith("armada-c2-"));
    expect(merged).toHaveLength(1);
    expect(merged[0].filter).toEqual({ kinds: [1059], authors: ["s1", "s2"] });

    const split = buildPushSubscriptions(
      baseInput({ concordV2: [sub(["wss://a"], "s1"), sub(["wss://b"], "s2")] }),
    ).filter((s) => s.id.startsWith("armada-c2-"));
    expect(split).toHaveLength(2);
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

describe("scopePushSubscriptionId", () => {
  it("is deterministic and stays within the server's 64-character limit", () => {
    const id = scopePushSubscriptionId("armada-groups", ME, "armada.buzz");
    expect(id).toBe(scopePushSubscriptionId("armada-groups", ME, "armada.buzz"));
    expect(id).toMatch(/^armada-groups-[0-9a-f]{32}$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("does not collide across users or web origins", () => {
    const first = scopePushSubscriptionId("armada-groups", ME, "armada.buzz");
    const otherUser = scopePushSubscriptionId(
      "armada-groups",
      "other".padEnd(64, "0"),
      "armada.buzz",
    );
    const otherDomain = scopePushSubscriptionId("armada-groups", ME, "chat.example.com");

    expect(new Set([first, otherUser, otherDomain])).toHaveLength(3);
  });

  it("truncates long logical ids before appending the scope digest", () => {
    const id = scopePushSubscriptionId("x".repeat(100), ME, "armada.buzz");
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^x{31}-[0-9a-f]{32}$/);
  });
});
