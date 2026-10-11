import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  _relaunchSelfReadMarksForTests,
  loadSelfReadMarks,
  noteSelfRead,
  SELF_READ_SLACK_SECS,
  selfReadMark,
  sinceSelfRead,
  storeSelfReadEvents,
} from "@/lib/selfReadMarks";

const now = () => Math.floor(Date.now() / 1000);

describe("self-state read marks", () => {
  it("survive a relaunch", async () => {
    const at = now() - 60;
    noteSelfRead("me\u0000wss://a\u0000", at);
    await _relaunchSelfReadMarksForTests();
    expect(selfReadMark("me\u0000wss://a\u0000")).toBeUndefined();
    await loadSelfReadMarks();
    expect(selfReadMark("me\u0000wss://a\u0000")).toBe(at);
  });

  it("only advance", async () => {
    noteSelfRead("k-advance", now() - 10);
    noteSelfRead("k-advance", now() - 100);
    expect(selfReadMark("k-advance")).toBe(now() - 10);
  });

  it("drop marks older than 30 days or in the future", async () => {
    noteSelfRead("k-old", now() - 31 * 24 * 3600);
    noteSelfRead("k-future", now() + 3600);
    await _relaunchSelfReadMarksForTests();
    await loadSelfReadMarks();
    expect(selfReadMark("k-old")).toBeUndefined();
    expect(selfReadMark("k-future")).toBeUndefined();
  });
});

describe("resumed self reads", () => {
  it("resume from the mark minus slack, and read whole without one", () => {
    const at = now() - 60;
    noteSelfRead("gifs-k", at);
    expect(sinceSelfRead([{ kinds: [30078] }], "gifs-k")).toEqual([{ kinds: [30078], since: at - SELF_READ_SLACK_SECS }]);
    expect(sinceSelfRead([{ kinds: [30078] }], "never-read")).toEqual([{ kinds: [30078] }]);
  });

  it("store only verified events that match what was asked", async () => {
    const sk = generateSecretKey();
    const mine = finalizeEvent({ kind: 30078, content: "", tags: [["t", "gifs"]], created_at: now() }, sk);
    const other = finalizeEvent({ kind: 1, content: "", tags: [], created_at: now() }, sk);
    const forged = { ...mine, id: mine.id, content: "tampered" };
    const stored: string[] = [];
    await storeSelfReadEvents(
      { event: async (e) => void stored.push(e.content) },
      [{ kinds: [30078], authors: [mine.pubkey], since: now() - 10 }],
      [mine, other, forged],
    );
    expect(stored).toEqual([""]);
  });
});
