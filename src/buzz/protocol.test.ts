import { describe, expect, it } from "vitest";

import {
  applyEditTagOverlay,
  buildBuzzReplyTags,
  buzzChannelType,
  buzzThreadRef,
  collectDeletedIds,
  collectEdits,
  foldBuzzTimeline,
  isBroadcastReply,
  isThreadReply,
  parseSystemMessage,
  tallyForumVotes,
} from "@/buzz/protocol";
import { BUZZ_TIMELINE_CONTENT_KINDS } from "@/buzz/kinds";
import { buildBuzzInviteUrl, parseBuzzInviteUrl } from "@/buzz/invite";

import type { NostrEvent } from "@nostrify/nostrify";

const HEX = (n: number) => n.toString(16).padStart(64, "0");

function ev(partial: Partial<NostrEvent> & { id: string; kind: number }): NostrEvent {
  return {
    pubkey: HEX(1),
    created_at: 1000,
    content: "",
    tags: [],
    sig: "",
    ...partial,
  };
}

describe("buzzThreadRef", () => {
  it("returns nulls without a marked reply tag", () => {
    expect(buzzThreadRef([["e", HEX(2)]])).toEqual({ parentId: null, rootId: null });
    // A root-only marker does NOT thread (Buzz requires the reply marker).
    expect(buzzThreadRef([["e", HEX(2), "", "root"]])).toEqual({ parentId: null, rootId: null });
  });

  it("threads on the marked reply tag; root falls back to the parent", () => {
    expect(buzzThreadRef([["e", HEX(2), "", "reply"]])).toEqual({
      parentId: HEX(2),
      rootId: HEX(2),
    });
    expect(
      buzzThreadRef([
        ["e", HEX(2), "", "root"],
        ["e", HEX(3), "", "reply"],
      ]),
    ).toEqual({ parentId: HEX(3), rootId: HEX(2) });
  });
});

describe("broadcast replies", () => {
  it("detects broadcast tag", () => {
    expect(isBroadcastReply([["broadcast", "1"]])).toBe(true);
    expect(isBroadcastReply([["broadcast", "0"]])).toBe(false);
    expect(isBroadcastReply([])).toBe(false);
  });

  it("a broadcast reply is not a thread-only reply", () => {
    const tags = [["e", HEX(2), "", "reply"], ["broadcast", "1"]];
    expect(isThreadReply(tags)).toBe(false);
    expect(buzzThreadRef(tags).parentId).toBe(HEX(2));
  });
});

describe("buildBuzzReplyTags", () => {
  it("direct reply to a root carries a single marked reply tag", () => {
    const tags = buildBuzzReplyTags("chan", HEX(9), HEX(2), HEX(2));
    expect(tags).toContainEqual(["e", HEX(2), "", "reply"]);
    expect(tags.filter(([n]) => n === "e")).toHaveLength(1);
    expect(tags).toContainEqual(["h", "chan"]);
    expect(tags).toContainEqual(["p", HEX(9)]);
  });

  it("nested reply pins the root", () => {
    const tags = buildBuzzReplyTags("chan", HEX(9), HEX(3), HEX(2));
    expect(tags).toContainEqual(["e", HEX(2), "", "root"]);
    expect(tags).toContainEqual(["e", HEX(3), "", "reply"]);
  });
});

describe("deletions + edits", () => {
  it("collects targets from both kind 5 and kind 9005", () => {
    const events = [
      ev({ id: HEX(10), kind: 5, tags: [["e", HEX(2)]] }),
      ev({ id: HEX(11), kind: 9005, tags: [["e", HEX(3)], ["h", "chan"]] }),
    ];
    expect(collectDeletedIds(events)).toEqual(new Set([HEX(2), HEX(3)]));
  });

  it("keeps the latest edit per target, skipping deleted targets", () => {
    const events = [
      ev({ id: HEX(20), kind: 40003, created_at: 5, content: "old", tags: [["e", HEX(2)]] }),
      ev({ id: HEX(21), kind: 40003, created_at: 9, content: "new", tags: [["e", HEX(2)]] }),
      ev({ id: HEX(22), kind: 40003, created_at: 9, content: "gone", tags: [["e", HEX(3)]] }),
    ];
    const edits = collectEdits(events, new Set([HEX(3)]));
    expect(edits.get(HEX(2))?.content).toBe("new");
    expect(edits.has(HEX(3))).toBe(false);
  });

  it("applyEditTagOverlay swaps imeta and keeps everything else", () => {
    const original = [["h", "chan"], ["imeta", "url https://a"], ["p", HEX(4)]];
    const edit = [["e", HEX(2)], ["imeta", "url https://b"]];
    expect(applyEditTagOverlay(original, edit)).toEqual([
      ["h", "chan"],
      ["p", HEX(4)],
      ["imeta", "url https://b"],
    ]);
    expect(applyEditTagOverlay(original, undefined)).toBe(original);
  });
});

describe("foldBuzzTimeline", () => {
  it("applies deletions, folds edits, partitions thread replies", () => {
    const root = ev({ id: HEX(2), kind: 9, created_at: 10, content: "root", tags: [["h", "c"]] });
    const reply = ev({
      id: HEX(3),
      kind: 9,
      created_at: 11,
      content: "reply",
      tags: [["h", "c"], ["e", HEX(2), "", "reply"]],
    });
    const broadcast = ev({
      id: HEX(4),
      kind: 9,
      created_at: 12,
      content: "broadcast",
      tags: [["h", "c"], ["e", HEX(2), "", "reply"], ["broadcast", "1"]],
    });
    const deleted = ev({ id: HEX(5), kind: 9, created_at: 13, content: "bye", tags: [["h", "c"]] });
    const deletion = ev({ id: HEX(6), kind: 9005, created_at: 14, tags: [["e", HEX(5)]] });
    const edit = ev({
      id: HEX(7),
      kind: 40003,
      created_at: 15,
      content: "root v2",
      tags: [["e", HEX(2)]],
    });

    const folded = foldBuzzTimeline(
      [root, reply, broadcast, deleted, deletion, edit],
      BUZZ_TIMELINE_CONTENT_KINDS,
    );

    // Timeline: root (edited) + broadcast reply; the plain reply and the
    // deleted message are absent.
    expect(folded.timeline.map((e) => e.id)).toEqual([HEX(2), HEX(4)]);
    const foldedRoot = folded.timeline[0];
    expect(foldedRoot.content).toBe("root v2");
    expect(foldedRoot.tags).toContainEqual(["edited", "15"]);

    // Threads: BOTH replies bucket under the root (broadcast surfaces in the
    // timeline AND belongs to the thread).
    expect(folded.repliesByRoot.get(HEX(2))?.map((e) => e.id)).toEqual([HEX(3), HEX(4)]);
  });
});

describe("parseSystemMessage", () => {
  it("parses a typed JSON payload", () => {
    const e = ev({
      id: HEX(30),
      kind: 40099,
      content: JSON.stringify({ type: "member_joined", actor: HEX(1), target: HEX(2) }),
    });
    expect(parseSystemMessage(e)).toEqual({
      type: "member_joined",
      actor: HEX(1),
      target: HEX(2),
      topic: undefined,
      purpose: undefined,
      visibility: undefined,
      ttlSeconds: undefined,
    });
  });

  it("rejects malformed payloads", () => {
    expect(parseSystemMessage(ev({ id: HEX(31), kind: 40099, content: "not json" }))).toBeUndefined();
    expect(parseSystemMessage(ev({ id: HEX(32), kind: 9, content: "{}" }))).toBeUndefined();
  });
});

describe("buzzChannelType", () => {
  it("reads the t tag and falls back via hidden", () => {
    expect(buzzChannelType(ev({ id: HEX(40), kind: 39000, tags: [["t", "forum"]] }))).toBe("forum");
    expect(buzzChannelType(ev({ id: HEX(41), kind: 39000, tags: [["hidden"]] }))).toBe("dm");
    expect(buzzChannelType(ev({ id: HEX(42), kind: 39000, tags: [] }))).toBe("stream");
  });
});

describe("tallyForumVotes", () => {
  it("counts one vote per pubkey, latest wins, tracks the viewer's vote", () => {
    const votes = [
      ev({ id: HEX(50), kind: 45002, pubkey: HEX(1), created_at: 1, content: "+", tags: [["e", HEX(9)]] }),
      ev({ id: HEX(51), kind: 45002, pubkey: HEX(1), created_at: 2, content: "-", tags: [["e", HEX(9)]] }),
      ev({ id: HEX(52), kind: 45002, pubkey: HEX(2), created_at: 1, content: "+", tags: [["e", HEX(9)]] }),
    ];
    const tallies = tallyForumVotes(votes, HEX(1));
    expect(tallies.get(HEX(9))).toEqual({
      up: 1,
      down: 1,
      mine: { eventId: HEX(51), value: "-" },
    });
  });
});

describe("parseBuzzInviteUrl", () => {
  it("parses a Buzz invite landing URL", () => {
    const invite = parseBuzzInviteUrl(
      "https://soapbox.communities.buzz.xyz/invite/eyJjIjoiNjU2YzcxNmIifQ.92Tdbmlf38m",
    );
    expect(invite).toBeDefined();
    expect(invite?.host).toBe("soapbox.communities.buzz.xyz");
    expect(invite?.relayUrl).toBe("wss://soapbox.communities.buzz.xyz");
    expect(invite?.origin).toBe("https://soapbox.communities.buzz.xyz");
    expect(invite?.code).toBe("eyJjIjoiNjU2YzcxNmIifQ.92Tdbmlf38m");
  });

  it("resolves the relay from ?r= on an Armada-hosted link", () => {
    const invite = parseBuzzInviteUrl(
      "https://armada.buzz/invite/eyJjIjoiNjU2YzcxNmIifQ.92Tdbmlf38m?r=soapbox.communities.buzz.xyz",
    );
    expect(invite).toBeDefined();
    // The relay is the ?r= host, not the (façade) armada.buzz link host.
    expect(invite?.host).toBe("soapbox.communities.buzz.xyz");
    expect(invite?.relayUrl).toBe("wss://soapbox.communities.buzz.xyz");
    expect(invite?.origin).toBe("https://soapbox.communities.buzz.xyz");
    expect(invite?.code).toBe("eyJjIjoiNjU2YzcxNmIifQ.92Tdbmlf38m");
  });

  it("round-trips buildBuzzInviteUrl through parseBuzzInviteUrl", () => {
    const url = buildBuzzInviteUrl(
      "https://armada.buzz",
      "wss://soapbox.communities.buzz.xyz",
      "eyJjIjoiNjU2YzcxNmIifQ.92Tdbmlf38m",
    );
    expect(url).toBe(
      "https://armada.buzz/invite/eyJjIjoiNjU2YzcxNmIifQ.92Tdbmlf38m?r=soapbox.communities.buzz.xyz",
    );
    const invite = parseBuzzInviteUrl(url);
    expect(invite?.relayUrl).toBe("wss://soapbox.communities.buzz.xyz");
    expect(invite?.code).toBe("eyJjIjoiNjU2YzcxNmIifQ.92Tdbmlf38m");
  });

  it("rejects Concord naddr invites and non-invite URLs", () => {
    expect(
      parseBuzzInviteUrl("https://armada.buzz/invite/naddr1qqxnzdesxgmnwd3jxs6rswpnqgs2m"),
    ).toBeUndefined();
    expect(parseBuzzInviteUrl("https://example.com/invite/plaincode")).toBeUndefined();
    expect(parseBuzzInviteUrl("wss://relay.example.com")).toBeUndefined();
    expect(parseBuzzInviteUrl("not a url")).toBeUndefined();
  });
});
