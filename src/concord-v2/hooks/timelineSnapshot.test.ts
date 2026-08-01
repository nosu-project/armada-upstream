/**
 * The timeline snapshot's honesty rules, pinned:
 *
 *  - a persisted window seeds an empty cache, STALE (so the mount still reads);
 *  - a populated cache is never overwritten;
 *  - rows claiming another channel are dropped;
 *  - the window is capped to the newest rows.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { purgeArmadaDB } from "@/lib/db/armadaDB";
import { __resetFoldedForTests } from "@/lib/foldedCache";

import {
  _resetTimelineSnapshotForTests,
  persistTimelineSnapshot,
  prewarmTimelineSnapshot,
} from "./timelineSnapshot";

import type { OpenedChat } from "@/concord-v2/lib/chat";

const CH = "c".repeat(64);
const key = ["concord2", "channel", CH] as const;

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

describe("timelineSnapshot", () => {
  it("round-trips a window into an empty cache, marked stale", async () => {
    await persistTimelineSnapshot(CH, [row("1", 1000), row("2", 2000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, CH, key);

    const data = qc.getQueryData<OpenedChat[]>(key);
    expect(data?.map((m) => m.rumorId)).toEqual(["2", "1"]);
    // Stale on arrival: the mount must still run the real store read.
    expect(qc.getQueryState(key)?.dataUpdatedAt).toBeLessThan(Date.now() - 1000);
  });

  it("never overwrites a populated cache", async () => {
    await persistTimelineSnapshot(CH, [row("old", 1000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    qc.setQueryData(key, [row("live", 5000)]);
    await prewarmTimelineSnapshot(qc, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["live"]);
  });

  it("drops rows claiming another channel", async () => {
    const other = "d".repeat(64);
    await persistTimelineSnapshot(CH, [row("mine", 1000), row("foreign", 2000, other)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)?.map((m) => m.rumorId)).toEqual(["mine"]);
  });

  it("caps the persisted window to the newest rows", async () => {
    const rows = Array.from({ length: 45 }, (_, i) => row(`m${i}`, i));
    await persistTimelineSnapshot(CH, rows);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, CH, key);

    const data = qc.getQueryData<OpenedChat[]>(key);
    expect(data).toHaveLength(40);
    // Newest kept: ms 44 down to 5.
    expect(data?.[0].rumorId).toBe("m44");
    expect(data?.some((m) => m.rumorId === "m4")).toBe(false);
  });

  it("prewarms once per channel per session", async () => {
    await persistTimelineSnapshot(CH, [row("1", 1000)]);
    _resetTimelineSnapshotForTests();

    const qc = new QueryClient();
    await prewarmTimelineSnapshot(qc, CH, key);
    qc.removeQueries({ queryKey: key });
    await prewarmTimelineSnapshot(qc, CH, key);

    expect(qc.getQueryData<OpenedChat[]>(key)).toBeUndefined();
  });
});
