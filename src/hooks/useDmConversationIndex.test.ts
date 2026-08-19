import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dmConversationDeviceId,
  getDmConversationIndexRecords,
  hydrateDmConversationIndexShards,
  loadOwnDmConversationIndexShards,
  recordDmConversationIndex,
  resetDmConversationIndexCache,
  subscribeDmConversationIndexChanges,
  useDmConversationIndex,
  useDmConversationIndexReady,
} from "@/hooks/useDmConversationIndex";
import {
  dmConversationIndexBucket,
  type DmConversationIndexRecord,
  type DmConversationIndexShard,
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

function shard(deviceId: string, records: DmConversationIndexRecord[]): DmConversationIndexShard {
  if (records.length === 0) throw new Error("test shard needs one bucket");
  return {
    version: 1,
    deviceId,
    bucket: dmConversationIndexBucket(records[0]!.key),
    records,
  };
}

beforeEach(async () => {
  localStorage.clear();
  await resetDmConversationIndexCache();
  vi.restoreAllMocks();
});
describe("local DM conversation index", () => {
  it("unions different installation shards without copying them into one coordinate", async () => {
    const phone = record(hex(1), 10);
    const desktop = record(hex(2), 20, true);
    await hydrateDmConversationIndexShards(SELF, [
      shard("phone-device", [phone]),
      shard("desktop-device", [desktop]),
    ]);

    expect((await getDmConversationIndexRecords(SELF)).map((entry) => entry.key))
      .toEqual([desktop.key, phone.key]);
    expect((await loadOwnDmConversationIndexShards(SELF)).flatMap((item) => item.records))
      .toEqual([]);
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
    const own = await loadOwnDmConversationIndexShards(SELF);
    expect(own.find((item) => item.bucket === dmConversationIndexBucket(entry.key))?.records)
      .toEqual([entry]);
    expect(changed).toEqual([[dmConversationIndexBucket(entry.key)]]);
    unsubscribe();
  });

  it("merges the remote copy of this installation before the next local rewrite", async () => {
    const deviceId = dmConversationDeviceId(SELF);
    const restored = record(hex(4), 40);
    await hydrateDmConversationIndexShards(SELF, [shard(deviceId, [restored])]);
    await recordDmConversationIndex(SELF, [record(hex(5), 50)]);

    expect((await loadOwnDmConversationIndexShards(SELF)).flatMap((item) => item.records)
      .map((entry) => entry.key).sort()).toEqual([hex(4), hex(5)].sort());
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
