import { nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dmRouteParam } from "@/lib/dmConversation";
import { dmConvKey } from "@/lib/nip17/protocol";
import { chatRoute } from "@/lib/routes";
import {
  assignShareRoute,
  consumeShareFor,
  discardShare,
  onShareStashChanged,
  pendingSharePreview,
  shortcutShareRoute,
  stashShare,
  type SharePayload,
} from "@/lib/shareTarget";

const payload = (text: string): SharePayload => ({ text, files: [] });

describe("share stash", () => {
  beforeEach(() => {
    discardShare();
  });

  it("hands a routed payload to the composer serving that room, once", () => {
    stashShare(payload("hello"), "/dm/npub1abc");

    expect(consumeShareFor("/dm/npub1abc")?.text).toBe("hello");
    expect(consumeShareFor("/dm/npub1abc")).toBeNull();
  });

  /**
   * The stash is matched by an exact string, so both ends have to build that
   * string the same way — and they build it from different things. SharePage
   * picks a destination out of a `Dm17Conversation`, whose peers are HEX;
   * DMsPage's composer names itself from the conversation key through
   * `dmRouteParam`, which is NPUBS. Driving the real producers rather than a
   * literal is the point of this test: it round-tripped a hand-written
   * "/dm/npub1abc" through the stash for as long as the two disagreed, while
   * every share picked from the picker opened the right DM with an empty
   * composer.
   */
  it("matches the picker's destination to the composer that declares it", () => {
    const peer = "a1".repeat(32); // Dm17Conversation.peers[0]
    const picked = chatRoute({ kind: "dm", peer }); // SharePage's pick()
    const declared = chatRoute({ kind: "dm", peer: dmRouteParam(dmConvKey([peer])) }); // DMsPage

    stashShare(payload("shared text"), picked);

    expect(consumeShareFor(declared)?.text).toBe("shared text");
  });

  it("matches a group DM's composer, whose route names every participant", () => {
    const peers = ["a1".repeat(32), "b2".repeat(32)].sort();
    const key = dmConvKey(peers);

    stashShare(payload("shared text"), chatRoute({ kind: "dm", peer: key }));

    expect(
      consumeShareFor(chatRoute({ kind: "dm", peer: dmRouteParam(key) }))?.text,
    ).toBe("shared text");
  });

  /**
   * The composer names ITSELF, so a composer serving another room is refused
   * even though the location may already have moved to the destination: a
   * route transition keeps the page being left mounted while the destination's
   * chunk loads, and it used to claim the payload by reading `window.location`.
   */
  it("refuses a composer that serves a different room", () => {
    stashShare(payload("hello"), "/dm/npub1abc");

    expect(consumeShareFor("/c/comm/chan")).toBeNull();
    expect(consumeShareFor("/s/relay.example/group")).toBeNull();
    // Still there for the composer it was addressed to.
    expect(consumeShareFor("/dm/npub1abc")?.text).toBe("hello");
  });

  /** A composer with no room of its own (the thread panel) is not a target. */
  it("refuses a composer with no share route", () => {
    stashShare(payload("hello"), "/c/comm/chan");

    expect(consumeShareFor(undefined)).toBeNull();
    expect(consumeShareFor("/c/comm/chan")?.text).toBe("hello");
  });

  it("withholds an unrouted payload from every composer until it is routed", () => {
    stashShare(payload("hello"), null);

    expect(pendingSharePreview()?.text).toBe("hello");
    expect(consumeShareFor("/c/comm/chan")).toBeNull();

    assignShareRoute("/c/comm/chan");

    expect(pendingSharePreview()).toBeNull();
    expect(consumeShareFor("/c/comm/chan")?.text).toBe("hello");
  });

  it("notifies subscribers so a composer mounted before the payload lands sees it", () => {
    const seen: string[] = [];
    const off = onShareStashChanged(() => {
      const share = consumeShareFor("/dm/npub1abc");
      if (share) seen.push(share.text);
    });

    // The peek navigated first; the files finished copying after.
    stashShare(payload("late"), "/dm/npub1abc");
    off();

    // Exactly once: the consume clears the stash and re-emits, so a subscriber
    // that consumes from its own callback must not see the payload twice.
    expect(seen).toEqual(["late"]);
  });

  it("drops the payload on discard", () => {
    stashShare(payload("hello"), "/dm/npub1abc");
    discardShare();

    expect(consumeShareFor("/dm/npub1abc")).toBeNull();
    expect(pendingSharePreview()).toBeNull();
  });

  it("emits nothing when there was nothing to discard", () => {
    const cb = vi.fn();
    const off = onShareStashChanged(cb);
    discardShare();
    off();

    expect(cb).not.toHaveBeenCalled();
  });
});

describe("shortcutShareRoute", () => {
  it("accepts a room, which is what a composer mounts at", () => {
    expect(shortcutShareRoute("/dm/npub1abc")).toBe("/dm/npub1abc");
    expect(shortcutShareRoute("/c/comm/chan")).toBe("/c/comm/chan");
    expect(shortcutShareRoute("/s/relay.example/group")).toBe("/s/relay.example/group");
  });

  it("refuses anything that redirects on mount, stranding the payload", () => {
    expect(shortcutShareRoute("/dm")).toBeNull();
    expect(shortcutShareRoute("/c/comm")).toBeNull();
    expect(shortcutShareRoute("/s/relay.example")).toBeNull();
    expect(shortcutShareRoute("/settings")).toBeNull();
  });

  /**
   * A shortcut id was written by a PREVIOUS version of this app and handed
   * back by the OS, so it can carry the hex peer that DM routes used before
   * they were canonicalized. Republishing retires those ids eventually; this
   * is what makes the ones already sitting on the launcher work today, and it
   * matters because the same value is both the navigation target and the
   * stash key.
   */
  it("canonicalizes a shortcut id published before DM routes were npubs", () => {
    const peer = "a1".repeat(32);

    expect(shortcutShareRoute(`/dm/${peer}`)).toBe(`/dm/${nip19.npubEncode(peer)}`);
    expect(shortcutShareRoute(`/dm/${peer}`)).toBe(chatRoute({ kind: "dm", peer }));
  });
});
