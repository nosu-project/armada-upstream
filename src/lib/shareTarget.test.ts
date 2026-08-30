import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assignShareRoute,
  consumeShareFor,
  discardShare,
  isShareableRoomRoute,
  onShareStashChanged,
  pendingSharePreview,
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

describe("isShareableRoomRoute", () => {
  it("accepts a room, which is what a composer mounts at", () => {
    expect(isShareableRoomRoute("/dm/npub1abc")).toBe(true);
    expect(isShareableRoomRoute("/c/comm/chan")).toBe(true);
    expect(isShareableRoomRoute("/s/relay.example/group")).toBe(true);
  });

  it("refuses anything that redirects on mount, stranding the payload", () => {
    expect(isShareableRoomRoute("/dm")).toBe(false);
    expect(isShareableRoomRoute("/c/comm")).toBe(false);
    expect(isShareableRoomRoute("/s/relay.example")).toBe(false);
    expect(isShareableRoomRoute("/settings")).toBe(false);
  });
});
