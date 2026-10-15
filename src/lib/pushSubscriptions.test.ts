import { describe, expect, it } from "vitest";

import {
  buildPushSubscriptions,
  type PushSubscriptionInput,
} from "@/lib/pushSubscriptions";
import { DEFAULT_PUSH_PREFS } from "@/lib/pushPrefs";

const ME = "me".padEnd(64, "0");

type InputOverrides = Partial<PushSubscriptionInput> & {
  /** Concise compatibility spelling used by the pre-relay-scope test cases. */
  relayUrls?: string[];
  groupIds?: string[];
  mentionOnlyGroupIds?: string[];
};

function baseInput(overrides: InputOverrides = {}): PushSubscriptionInput {
  const {
    relayUrls = [],
    groupIds = [],
    mentionOnlyGroupIds = [],
    ...current
  } = overrides;
  const mentions = new Set(mentionOnlyGroupIds);
  return {
    pubkey: ME,
    nip29Groups: relayUrls.flatMap((relay) => groupIds.map((groupId) => ({
      relay,
      groupId,
      level: mentions.has(groupId) ? "mentions" as const : "all" as const,
    }))),
    prefs: { ...DEFAULT_PUSH_PREFS },
    dmRelays: [],
    dmFollows: [],
    dmLevels: {},
    concord: [],
    ...current,
  };
}

function byId(specs: ReturnType<typeof buildPushSubscriptions>) {
  return new Map(specs.map((s) => [s.id, s]));
}

function replacing(
  specs: ReturnType<typeof buildPushSubscriptions>,
  base: string,
) {
  return specs.find((spec) => spec.replaces?.includes(base));
}

describe("buildPushSubscriptions", () => {
  it("returns nothing when there is nothing to watch", () => {
    expect(buildPushSubscriptions(baseInput())).toEqual([]);
  });

  it("keeps kind-9 all-message and mention filters disjoint", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({ relayUrls: ["wss://r"], groupIds: ["g1", "g2"] }),
      ),
    );
    const all = replacing([...specs.values()], "armada-groups")!;
    expect(all.filter.kinds).toEqual([9]);
    expect(all.filter["#h"]).toEqual(["g1", "g2"]);
    expect(all.filter["#p"]).toBeUndefined();
    expect(all.notification.data.scope).toBe("group");

    const directed = replacing([...specs.values()], "armada-groups-directed")!;
    expect(directed.filter["#p"]).toEqual([ME]);
    expect(directed.filter["#h"]).toEqual(["g1", "g2"]);
    expect(directed.filter.kinds).toEqual([1111, 7]);
    expect(replacing([...specs.values()], "armada-groups-mention")).toBeUndefined();
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
    expect(replacing([...specs.values()], "armada-groups")!.filter["#h"]).toEqual(["g1"]);
    // Kind 9 is split over disjoint h sets, so one event can match only one.
    expect(replacing([...specs.values()], "armada-groups-mention")!.filter["#h"]).toEqual(["g2"]);
    expect(replacing([...specs.values()], "armada-groups-directed")!.filter["#h"])
      .toEqual(["g1", "g2"]);
  });

  it("does not cross-product the same group id across relays or collapse its exact levels", () => {
    const specs = buildPushSubscriptions(baseInput({
      nip29Groups: [
        { relay: "wss://all.example", groupId: "general", level: "all" },
        { relay: "wss://mentions.example", groupId: "general", level: "mentions" },
      ],
    }));
    const all = specs.find((spec) =>
      spec.filter.kinds?.includes(9) && spec.filter["#p"] === undefined)!;
    const mention = specs.find((spec) =>
      spec.filter.kinds?.includes(9) && spec.filter["#p"]?.includes(ME))!;

    expect(all.relays).toEqual(["wss://all.example"]);
    expect(all.filter["#h"]).toEqual(["general"]);
    expect(mention.relays).toEqual(["wss://mentions.example"]);
    expect(mention.filter["#h"]).toEqual(["general"]);
    expect(all.replaces).toContain("armada-groups");
    expect(mention.replaces).toContain("armada-groups-mention");
    expect(new Set(specs.flatMap((spec) => spec.relays))).toEqual(new Set([
      "wss://all.example",
      "wss://mentions.example",
    ]));
  });

  it("keeps the surviving relay id stable when a two-relay watch becomes one", () => {
    const two = buildPushSubscriptions(baseInput({
      nip29Groups: [
        { relay: "wss://a.example", groupId: "general", level: "all" },
        { relay: "wss://b.example", groupId: "general", level: "all" },
      ],
    }));
    const one = buildPushSubscriptions(baseInput({
      nip29Groups: [
        { relay: "wss://a.example", groupId: "general", level: "all" },
      ],
    }));
    const twoA = two.find((spec) =>
      spec.replaces?.includes("armada-groups")
      && spec.relays[0] === "wss://a.example")!;
    const oneA = replacing(one, "armada-groups")!;

    expect(oneA.id).toBe(twoA.id);
    expect(oneA.id).not.toBe("armada-groups");
    expect(oneA.replaces).toEqual(["armada-groups"]);
  });

  it("uses relay-scoped ids for both sides of a one-relay level transition", () => {
    const all = replacing(buildPushSubscriptions(baseInput({
      nip29Groups: [
        { relay: "wss://a.example", groupId: "general", level: "all" },
      ],
    })), "armada-groups")!;
    const mentions = replacing(buildPushSubscriptions(baseInput({
      nip29Groups: [
        { relay: "wss://a.example", groupId: "general", level: "mentions" },
      ],
    })), "armada-groups-mention")!;

    expect(all.id).not.toBe("armada-groups");
    expect(mentions.id).not.toBe("armada-groups-mention");
    expect(all.id).not.toBe(mentions.id);
    expect(all.replaces).toEqual(["armada-groups"]);
    expect(mentions.replaces).toEqual(["armada-groups-mention"]);
  });

  it("retains an explicit all-level group when the global all switch is off", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          relayUrls: ["wss://r"],
          groupIds: ["g1"],
          prefs: { ...DEFAULT_PUSH_PREFS, allGroupMessages: false },
        }),
      ),
    );
    expect(replacing([...specs.values()], "armada-groups")).toBeDefined();
    expect(replacing([...specs.values()], "armada-groups-mention")).toBeUndefined();
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
    expect(replacing([...specs.values()], "armada-groups-directed")).toBeUndefined();
    expect(replacing([...specs.values()], "armada-groups")!.filter.kinds).toEqual([9]);
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
    expect(replacing([...specs.values()], "armada-groups-directed")).toBeUndefined();
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
      inline_event: true,
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

  it("keeps NIP-17 awake for an explicit DM override when global DMs are off", () => {
    const conversation = ["b".repeat(64), "a".repeat(64)].sort().join(",");
    const specs = byId(buildPushSubscriptions(baseInput({
      dmRelays: ["wss://dm"],
      dmLevels: { [conversation]: "all", ["c".repeat(64)]: "nothing" },
      prefs: { ...DEFAULT_PUSH_PREFS, directMessages: false },
    })));

    expect(specs.get("armada-dm17")?.filter).toEqual({ kinds: [1059], "#p": [ME] });
    // A group-DM participant set must not widen legacy author trust.
    expect(specs.has("armada-dm")).toBe(false);
  });

  it("adds an exact 1:1 NIP-04 author while global DMs are off", () => {
    const exact = "d".repeat(64);
    const specs = byId(buildPushSubscriptions(baseInput({
      dmRelays: ["wss://dm"],
      dmLevels: {
        [exact]: "all",
        [["a".repeat(64), "b".repeat(64)].join(",")]: "all",
      },
      prefs: { ...DEFAULT_PUSH_PREFS, directMessages: false },
    })));

    expect(specs.get("armada-dm")?.filter.authors).toEqual([exact]);
  });

  it("removes an exact nothing-level author while global DMs are on", () => {
    const off = "d".repeat(64);
    const on = "e".repeat(64);
    const specs = byId(buildPushSubscriptions(baseInput({
      dmRelays: ["wss://dm"],
      dmFollows: [off, on],
      dmLevels: { [off]: "nothing" },
    })));

    expect(specs.get("armada-dm")?.filter.authors).toEqual([on]);
  });

  it("does not wake NIP-17 when every explicit DM is nothing and global DMs are off", () => {
    const specs = buildPushSubscriptions(baseInput({
      dmRelays: ["wss://dm"],
      dmLevels: { ["a".repeat(64)]: "nothing" },
      prefs: { ...DEFAULT_PUSH_PREFS, directMessages: false },
    }));
    expect(specs.some((spec) => spec.id === "armada-dm17")).toBe(false);
  });

  it("maps Concord streams to a kind-1059 authors filter", () => {
    const specs = byId(
      buildPushSubscriptions(
        baseInput({
          concord: [
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

  it("raises no subscription for a muted Concord channel", () => {
    // A muted channel is carried in `concord` only so the caller can seal its
    // decrypt key into the device config (for the drop-after-decrypt defense).
    // It must never become a gateway subscription, or the mute would be the
    // thing that starts the wake-ups.
    const specs = buildPushSubscriptions(
      baseInput({
        concord: [
          {
            relays: ["wss://c"],
            communityId: "c",
            communityName: "",
            channelId: "muted",
            channelName: "",
            streams: [{ pk: "s-muted", convKey: "k", epoch: "0" }],
            timerSecs: 0,
            gitAttachments: [],
            muted: true,
          },
          {
            relays: ["wss://c"],
            communityId: "c",
            communityName: "",
            channelId: "live",
            channelName: "",
            streams: [{ pk: "s-live", convKey: "k", epoch: "0" }],
            timerSecs: 0,
            gitAttachments: [],
          },
        ],
      }),
    ).filter((s) => s.id.startsWith("armada-c2-"));
    expect(specs).toHaveLength(1);
    expect(specs[0].filter).toEqual({ kinds: [1059], authors: ["s-live"] });
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
      baseInput({ concord: [sub(["wss://c"], "s1"), sub(["wss://c"], "s2")] }),
    ).filter((s) => s.id.startsWith("armada-c2-"));
    expect(merged).toHaveLength(1);
    expect(merged[0].filter).toEqual({ kinds: [1059], authors: ["s1", "s2"] });

    const split = buildPushSubscriptions(
      baseInput({ concord: [sub(["wss://a"], "s1"), sub(["wss://b"], "s2")] }),
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

describe("inline_event", () => {
  it("asks for the inlined event on every subscription the worker can open", () => {
    // The worker renders from the real event and stores it; the gateway's
    // static title/body are only the fallback. A subscription that forgot to
    // opt in would silently be stuck on that fallback forever.
    //
    // `armada-dm` is the deliberate exception: it matches legacy kind-4
    // ciphertext, which the worker has no way to open, so inlining it would
    // spend payload budget to reach the same fallback.
    const specs = buildPushSubscriptions(
      baseInput({
        relayUrls: ["wss://r"],
        groupIds: ["g1", "g2"],
        mentionOnlyGroupIds: ["g2"],
        dmRelays: ["wss://dm"],
        dmFollows: ["friend".padEnd(64, "0")],
        concord: [{
          relays: ["wss://c"],
          communityId: "c".padEnd(64, "0"),
          communityName: "C",
          channelId: "ch".padEnd(64, "0"),
          channelName: "general",
          streams: [{ pk: "pk".padEnd(64, "0"), convKey: "k".padEnd(64, "0"), epoch: "1" }],
          timerSecs: 0,
          gitAttachments: [],
        }],
      }),
    );
    expect(specs.map((s) => s.id)).toContain("armada-dm");
    for (const spec of specs) {
      expect(spec.notification.data.inline_event, spec.id)
        .toBe(spec.id === "armada-dm" ? undefined : true);
    }
  });
});
