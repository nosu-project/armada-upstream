/**
 * The DM thread snapshot's honesty rules, pinned:
 *
 *  - a persisted window seeds an empty cache, STALE (so the mount still reads);
 *  - a populated cache is never overwritten;
 *  - rows claiming another conversation are dropped;
 *  - the window is capped to the newest rows;
 *  - NIP-40 expiry is enforced on BOTH sides, so a disappearing message never
 *    comes back from the cache.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import { purgeArmadaDB } from "@/lib/db/armadaDB";
import { __resetFoldedForTests } from "@/lib/foldedCache";

import {
  _resetDm17ThreadSnapshotForTests,
  persistDm17ThreadSnapshot,
  prewarmDm17ThreadSnapshot,
} from "./threadSnapshot";

import type { OpenedDm } from "@/lib/nip17/protocol";

const SELF = "a".repeat(64);
const PEER = "b".repeat(64);
const OTHER = "c".repeat(64);
const key = ["dm17", "thread", SELF, PEER, "allowed"] as const;

const now = () => Math.floor(Date.now() / 1000);

function row(id: string, createdAt: number, opts: { peer?: string; expiresAt?: number } = {}): OpenedDm {
  return {
    rumorId: id,
    wrapId: `wrap-${id}`,
    author: PEER,
    kind: 14,
    content: `msg ${id}`,
    tags: opts.expiresAt === undefined ? [] : [["expiration", String(opts.expiresAt)]],
    createdAt,
    peers: [opts.peer ?? PEER],
  };
}

afterEach(async () => {
  await purgeArmadaDB();
  __resetFoldedForTests();
  _resetDm17ThreadSnapshotForTests();
});

describe("dm17 threadSnapshot", () => {
  it("round-trips a window into an empty cache, marked stale", async () => {
    await persistDm17ThreadSnapshot(SELF, PEER, [row("1", 1000), row("2", 2000)]);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);

    expect(qc.getQueryData<OpenedDm[]>(key)?.map((m) => m.rumorId)).toEqual(["2", "1"]);
    // Stale on arrival: the mount must still run the real store read.
    expect(qc.getQueryState(key)?.dataUpdatedAt).toBeLessThan(Date.now() - 1000);
  });

  it("never overwrites a populated cache", async () => {
    await persistDm17ThreadSnapshot(SELF, PEER, [row("old", 1000)]);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    qc.setQueryData(key, [row("live", 5000)]);
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);

    expect(qc.getQueryData<OpenedDm[]>(key)?.map((m) => m.rumorId)).toEqual(["live"]);
  });

  it("drops rows claiming another conversation", async () => {
    await persistDm17ThreadSnapshot(SELF, PEER, [row("mine", 1000), row("foreign", 2000, { peer: OTHER })]);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);

    expect(qc.getQueryData<OpenedDm[]>(key)?.map((m) => m.rumorId)).toEqual(["mine"]);
  });

  it("scopes the snapshot per account, so another login reads a miss", async () => {
    await persistDm17ThreadSnapshot(SELF, PEER, [row("1", 1000)]);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    const otherKey = ["dm17", "thread", OTHER, PEER, "allowed"] as const;
    await prewarmDm17ThreadSnapshot(qc, OTHER, PEER, otherKey);

    expect(qc.getQueryData<OpenedDm[]>(otherKey)).toBeUndefined();
  });

  it("caps the persisted window to the newest rows", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => row(`m${i}`, 1000 + i));
    await persistDm17ThreadSnapshot(SELF, PEER, rows);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);

    const data = qc.getQueryData<OpenedDm[]>(key);
    expect(data).toHaveLength(80);
    expect(data?.[0].rumorId).toBe("m89");
    expect(data?.some((m) => m.rumorId === "m9")).toBe(false);
  });

  it("never persists an already-expired rumor", async () => {
    await persistDm17ThreadSnapshot(SELF, PEER, [
      row("live", 1000),
      row("gone", 2000, { expiresAt: now() - 60 }),
    ]);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);

    expect(qc.getQueryData<OpenedDm[]>(key)?.map((m) => m.rumorId)).toEqual(["live"]);
  });

  it("drops a rumor that expired AFTER it was persisted", async () => {
    // Written while still alive...
    const expiresAt = now() + 1;
    await persistDm17ThreadSnapshot(SELF, PEER, [row("live", 1000), row("soon", 2000, { expiresAt })]);
    _resetDm17ThreadSnapshotForTests();

    // ...read back past its deadline. The cache must not resurrect it.
    const qc = new QueryClient();
    const realNow = Date.now;
    Date.now = () => realNow() + 5_000;
    try {
      await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);
    } finally {
      Date.now = realNow;
    }

    expect(qc.getQueryData<OpenedDm[]>(key)?.map((m) => m.rumorId)).toEqual(["live"]);
  });

  it("prewarms once per query key per session", async () => {
    await persistDm17ThreadSnapshot(SELF, PEER, [row("1", 1000)]);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);
    qc.removeQueries({ queryKey: key });
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);

    expect(qc.getQueryData<OpenedDm[]>(key)).toBeUndefined();
  });

  it("re-seeds when the decrypt-consent state changes the query key", async () => {
    await persistDm17ThreadSnapshot(SELF, PEER, [row("1", 1000)]);
    _resetDm17ThreadSnapshotForTests();

    const qc = new QueryClient();
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, key);
    const declinedKey = ["dm17", "thread", SELF, PEER, "declined"] as const;
    await prewarmDm17ThreadSnapshot(qc, SELF, PEER, declinedKey);

    expect(qc.getQueryData<OpenedDm[]>(declinedKey)?.map((m) => m.rumorId)).toEqual(["1"]);
  });
});
