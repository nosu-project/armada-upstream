import { describe, expect, it } from "vitest";

import {
  DM_CONVERSATION_INDEX_BUCKETS,
  DM_CONVERSATIONS_D_PREFIX,
  DM_CONVERSATIONS_EVENT_KIND,
  DM_CONVERSATIONS_EVENT_TAG,
  MAX_DM_CONVERSATIONS_PER_SHARD,
  MAX_DM_CONVERSATION_PLAINTEXT_BYTES,
  dmConversationIndexBucket,
  dmConversationIndexDTag,
  dmConversationIndexFilter,
  fitDmConversationIndexShard,
  isCanonicalDmConversationKey,
  mergeDmConversationIndexRecords,
  newestDmConversationIndexEvents,
  parseDmConversationIndexDTag,
  parseDmConversationIndexPlaintext,
  parseDmConversationIndexShard,
  serializeDmConversationIndexShard,
  type DmConversationIndexRecord,
} from "@/lib/dmConversationIndex";
import { APP_ID } from "@/lib/platform";
import type { NostrRumor } from "@/lib/nostrRumor";

const SELF = "f".repeat(64);
const DEVICE = "device-12345678";

function hex(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function record(
  peer: string,
  createdAt: number,
  mine = false,
  id = hex(createdAt + 10_000),
): DmConversationIndexRecord {
  return { key: peer, latest: { createdAt, id }, mine };
}

function event(
  deviceId: string,
  bucket: number,
  createdAt: number,
  id: string,
  overrides: Partial<NostrRumor> = {},
): NostrRumor {
  return {
    id,
    pubkey: SELF,
    kind: DM_CONVERSATIONS_EVENT_KIND,
    created_at: createdAt,
    content: "ciphertext",
    tags: [
      ["d", dmConversationIndexDTag(deviceId, bucket)],
      ["t", DM_CONVERSATIONS_EVENT_TAG],
    ],
    ...overrides,
  };
}

describe("DM conversation index wire model", () => {
  it("uses a fork-safe opaque address and topic-scoped query", () => {
    expect(DM_CONVERSATIONS_D_PREFIX).toBe(`${APP_ID}/dm-conversations/`);
    const d = dmConversationIndexDTag(DEVICE, 3);
    expect(d).toBe(`${APP_ID}/dm-conversations/${DEVICE}/3`);
    expect(parseDmConversationIndexDTag(d)).toEqual({ deviceId: DEVICE, bucket: 3 });
    expect(parseDmConversationIndexDTag(`${d}/${hex(1)}`)).toBeNull();
    expect(dmConversationIndexFilter(SELF)).toMatchObject({
      kinds: [30078],
      authors: [SELF],
      "#t": [DM_CONVERSATIONS_EVENT_TAG],
    });
  });

  it("accepts only sorted unique lowercase participant sets", () => {
    const alice = hex(1);
    const bob = hex(2);
    expect(isCanonicalDmConversationKey(alice)).toBe(true);
    expect(isCanonicalDmConversationKey(`${alice},${bob}`)).toBe(true);
    expect(isCanonicalDmConversationKey(`${bob},${alice}`)).toBe(false);
    expect(isCanonicalDmConversationKey(`${alice},${alice}`)).toBe(false);
    expect(isCanonicalDmConversationKey("a".repeat(64).toUpperCase())).toBe(false);
    expect(isCanonicalDmConversationKey("npub1not-a-key")).toBe(false);
  });

  it("strictly validates bucket membership, records and array bounds", () => {
    const entry = record(hex(1), 1);
    const bucket = dmConversationIndexBucket(entry.key);
    const valid = { version: 1, deviceId: DEVICE, bucket, records: [entry] } as const;
    expect(parseDmConversationIndexShard(valid)).toEqual(valid);
    expect(parseDmConversationIndexShard({ ...valid, bucket: (bucket + 1) % 8 })).toBeNull();
    expect(parseDmConversationIndexShard({ ...valid, records: [{ ...entry, key: "bad" }] }))
      .toBeNull();
    expect(parseDmConversationIndexShard({
      ...valid,
      records: Array.from({ length: MAX_DM_CONVERSATIONS_PER_SHARD + 1 }, () => entry),
    })).toBeNull();
  });

  it("keeps the full 2,000-row one-to-one roster across stable bounded buckets", () => {
    const records = Array.from({ length: 2_000 }, (_, index) => record(hex(index + 1), index + 1));
    const fitted = Array.from({ length: DM_CONVERSATION_INDEX_BUCKETS }, (_, bucket) =>
      fitDmConversationIndexShard(DEVICE, bucket, records));
    const restored = mergeDmConversationIndexRecords(fitted.map((shard) => shard.records));

    expect(restored).toHaveLength(2_000);
    for (const shard of fitted) {
      expect(new TextEncoder().encode(serializeDmConversationIndexShard(shard)).byteLength)
        .toBeLessThanOrEqual(MAX_DM_CONVERSATION_PLAINTEXT_BYTES);
      expect(shard.records.every((entry) => dmConversationIndexBucket(entry.key) === shard.bucket))
        .toBe(true);
    }
  });

  it("unions add-only records and makes participation sticky", () => {
    const peer = hex(1);
    const old = record(peer, 10, true, hex(100));
    const latest = record(peer, 20, false, hex(200));
    expect(mergeDmConversationIndexRecords([[latest], [old]])).toEqual([{
      ...latest,
      mine: true,
    }]);

    const sameTimeHigherId = record(peer, 20, false, hex(201));
    expect(mergeDmConversationIndexRecords([[latest], [sameTimeHigherId]])[0]?.latest.id)
      .toBe(hex(201));
  });

  it("serializes metadata only and rejects oversized plaintext", () => {
    const entry = record(hex(1), 10, true);
    const shard = fitDmConversationIndexShard(DEVICE, dmConversationIndexBucket(entry.key), [entry]);
    const plaintext = serializeDmConversationIndexShard(shard);
    expect(parseDmConversationIndexPlaintext(plaintext)).toEqual(shard);
    expect(plaintext).not.toContain("content");
    expect(plaintext).not.toContain("preview");
    expect(plaintext).not.toContain("read");
    expect(parseDmConversationIndexPlaintext("x".repeat(MAX_DM_CONVERSATION_PLAINTEXT_BYTES + 1)))
      .toBeNull();
  });

  it("selects one NIP-01 winner per valid coordinate before decrypting", () => {
    const bucket = 2;
    const older = event(DEVICE, bucket, 10, hex(100));
    const tieHigherId = event(DEVICE, bucket, 20, hex(300));
    const tieLowerId = event(DEVICE, bucket, 20, hex(200));
    const other = event("other-device", bucket, 15, hex(400));
    const wrongTopic = event(DEVICE, 3, 30, hex(500), { tags: [["t", "other"]] });

    expect(newestDmConversationIndexEvents(
      [older, tieHigherId, tieLowerId, other, wrongTopic],
      SELF,
    ).map((candidate) => candidate.id)).toEqual([hex(200), hex(400)]);
  });
});
