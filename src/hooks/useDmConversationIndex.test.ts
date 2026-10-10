// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dmConversationIndexBuckets,
  getDmConversationIndexRecords,
  hydrateDmConversationIndexRecords,
  recordDmConversationIndex,
  resetDmConversationIndexCache,
  subscribeDmConversationIndexChanges,
  useDmConversationIndex,
  useDmConversationIndexReady,
} from "@/hooks/useDmConversationIndex";
import {
  dmConversationIndexBucket,
  type DmConversationIndexRecord,
} from "@/lib/dmConversationIndex";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "f".repeat(64) } }),
}));

const SELF = "f".repeat(64);

function hex(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function record(peer: string, createdAt: number, mine = false): DmConversationIndexRecord {
  return { key: peer, latest: { createdAt, id: hex(createdAt + 1_000) }, mine };
}

beforeEach(async () => {
  localStorage.clear();
  await resetDmConversationIndexCache();
  vi.restoreAllMocks();
});
describe("local DM conversation index", () => {
  it("unions remote record sets, and publishes the union", async () => {
    const phone = record(hex(1), 10);
    const desktop = record(hex(2), 20, true);
    await hydrateDmConversationIndexRecords(SELF, [[phone], [desktop]]);

    expect((await getDmConversationIndexRecords(SELF)).map((entry) => entry.key))
      .toEqual([desktop.key, phone.key]);
    // The shared documents are this device's whole knowledge, split by bucket.
    expect((await dmConversationIndexBuckets(SELF)).flatMap((item) => item.records).map((entry) => entry.key).sort())
      .toEqual([desktop.key, phone.key].sort());
  });

  it("persists changed rows in stable local buckets and emits only real changes", async () => {
    const changed: number[][] = [];
    const unsubscribe = subscribeDmConversationIndexChanges((pubkey, buckets) => {
      expect(pubkey).toBe(SELF);
      changed.push([...buckets]);
    });
    const entry = record(hex(3), 30, false);

    expect(await recordDmConversationIndex(SELF, [entry])).toBe(true);
    expect(await recordDmConversationIndex(SELF, [entry])).toBe(false);
    const buckets = await dmConversationIndexBuckets(SELF);
    expect(buckets.find((item) => item.bucket === dmConversationIndexBucket(entry.key))?.records)
      .toEqual([entry]);
    expect(changed).toEqual([[dmConversationIndexBucket(entry.key)]]);
    unsubscribe();
  });

  it("does not report hydrated records as local edits", async () => {
    const changed: number[][] = [];
    const unsubscribe = subscribeDmConversationIndexChanges((_pubkey, buckets) => changed.push([...buckets]));
    await hydrateDmConversationIndexRecords(SELF, [[record(hex(4), 40)]]);
    await recordDmConversationIndex(SELF, [record(hex(5), 50)]);

    expect((await getDmConversationIndexRecords(SELF)).map((entry) => entry.key).sort())
      .toEqual([hex(4), hex(5)].sort());
    expect(changed).toEqual([[dmConversationIndexBucket(hex(5))]]);
    unsubscribe();
  });

  it("publishes a stable readiness signal after the ArmadaDB warm", async () => {
    const { result } = renderHook(() => ({
      records: useDmConversationIndex(),
      ready: useDmConversationIndexReady(),
    }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.records).toEqual([]);
  });
});
