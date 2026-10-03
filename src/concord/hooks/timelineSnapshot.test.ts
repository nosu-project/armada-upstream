/**
 * The timeline snapshot's honesty rules, pinned:
 *
 *  - a persisted window seeds an empty cache, STALE (so the mount still reads);
 *  - a populated cache is never overwritten;
 *  - rows claiming another channel are dropped;
 *  - the window is capped to the newest rows;
 *  - another account on the same device reads none of it;
 *  - a send whose seal was never signed is never persisted, nor restored from
 *    a snapshot written before that rule (it would reload looking sent);
 *  - a seed is reported once, so the first store read can replace it.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { purgeArmadaDB } from "@/lib/db/armadaDB";
import { __resetFoldedForTests, writeFolded } from "@/lib/foldedCache";

import {
  _resetTimelineSnapshotForTests,
  persistTimelineSnapshot,
  prewarmTimelineSnapshot,
  takeSnapshotSeed,
} from "./timelineSnapshot";

import type { OpenedChat } from "@/concord/lib/chat";

const CH = "c".repeat(64);
const VIEWER = "1".repeat(64);
const OTHER_VIEWER = "2".repeat(64);
const key = ["concord", "channel", CH] as const;

function row(id: string, ms: number, channelIdHex = CH): OpenedChat {
  return {
    rumorId: id,
    wrapId: `wrap-${id}`,
    channelIdHex,
    epoch: 0n,
    kind: 9,
    author: "a".repeat(64),
    content: `msg ${id}`,
    tags: [["channel", channelIdHex]],
    ms,
  } as unknown as OpenedChat;
}

afterEach(async () => {
  await purgeArmadaDB();
  __resetFoldedForTests();
  _resetTimelineSnapshotForTests();
});

/** The optimistic row of a send whose seal never came back from the signer. */
const unsealed = (id: string, ms: number) => ({ ...row(id, ms), wrapId: "" });

describe("timelineSnapshot", () => {
  it("never persists an unsealed send", async () => {
    await persistTimelineSnapshot(VIEWER, CH, [row("sent", 1000), unsealed("ghost", 2000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);
    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["sent"]);
  });

  it("drops an unsealed send from a snapshot written before the rule", async () => {
    await writeFolded(`c2-timeline-snap:${VIEWER}:${CH}`, [unsealed("ghost", 2000), row("sent", 1000)]);

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);
    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["sent"]);
  });

  it("reports a seed exactly once, and only for the viewer it seeded", async () => {
    await persistTimelineSnapshot(VIEWER, CH, [row("1", 1000)]);
    _resetTimelineSnapshotForTests();
    expect(takeSnapshotSeed(VIEWER, CH)).toBe(false);

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);
    expect(takeSnapshotSeed(OTHER_VIEWER, CH)).toBe(false);
    expect(takeSnapshotSeed(VIEWER, CH)).toBe(true);
    expect(takeSnapshotSeed(VIEWER, CH)).toBe(false);
  });

  it("round-trips a window into an empty cache, marked stale", async () => {
    await persistTimelineSnapshot(VIEWER, CH, [row("1", 1000), row("2", 2000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);

    const data = qc.getQueryData<OpenedChat[]>(key);
    expect(data?.map((m) => m.rumorId)).toEqual(["2", "1"]);
    // Stale on arrival: the mount must still run the real store read.
    expect(qc.getQueryState(key)?.dataUpdatedAt).toBeLessThan(Date.now() - 1000);
  });

  it("never overwrites a populated cache", async () => {
    await persistTimelineSnapshot(VIEWER, CH, [row("old", 1000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    qc.setQueryData(key, [row("live", 5000)]);
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["live"]);
  });

  it("drops rows claiming another channel", async () => {
    const other = "d".repeat(64);
    await persistTimelineSnapshot(VIEWER, CH, [row("mine", 1000), row("foreign", 2000, other)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["mine"]);
  });

  it("caps the persisted window to the newest rows", async () => {
    const rows = Array.from({ length: 45 }, (_, i) => row(`m${i}`, i));
    await persistTimelineSnapshot(VIEWER, CH, rows);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);

    const data = qc.getQueryData<OpenedChat[]>(key);
    expect(data).toHaveLength(40);
    // Newest kept: ms 44 down to 5.
    expect(data?.[0].rumorId).toBe("m44");
    expect(data?.some((m) => m.rumorId === "m4")).toBe(false);
  });

  // The snapshot is the one Concord cache reached from the URL's channel id
  // rather than from a resolved Community, so without viewer scoping a second
  // account on the device could seed the first account's decrypted messages
  // just by visiting the route.
  it("does not seed another account's cache", async () => {
    await persistTimelineSnapshot(VIEWER, CH, [row("1", 1000), row("2", 2000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, OTHER_VIEWER, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)).toBeUndefined();

    // …and the owning account still reads its own window back.
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);
    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["2", "1"]);
  });

  it("keeps each account's window separate for the same channel", async () => {
    await persistTimelineSnapshot(VIEWER, CH, [row("mine", 1000)]);
    await persistTimelineSnapshot(OTHER_VIEWER, CH, [row("theirs", 2000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, OTHER_VIEWER, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["theirs"]);
  });

  it("prewarms once per channel per session", async () => {
    await persistTimelineSnapshot(VIEWER, CH, [row("1", 1000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);
    qc.removeQueries({ queryKey: key });
    await prewarmTimelineSnapshot(qc, VIEWER, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)).toBeUndefined();
  });
});
