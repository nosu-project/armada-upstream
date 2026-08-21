import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

import {
  decodeDmConversationIndexEvents,
  signCurrentDmConversationIndexEvents,
  verifiedDmConversationIndexEvents,
} from "@/hooks/useDmConversationIndexSync";
import {
  recordDmConversationIndex,
  resetDmConversationIndexCache,
} from "@/hooks/useDmConversationIndex";
import {
  DM_CONVERSATIONS_EVENT_KIND,
  DM_CONVERSATIONS_EVENT_TAG,
  dmConversationIndexBucket,
  dmConversationIndexDTag,
  serializeDmConversationIndexShard,
  type DmConversationIndexRecord,
  type DmConversationIndexShard,
} from "@/lib/dmConversationIndex";
import type { NostrRumor } from "@/lib/nostrRumor";

const SELF_SK = new Uint8Array(32).fill(7);
const SELF = getPublicKey(SELF_SK);

function hex(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function record(peer: string, createdAt: number): DmConversationIndexRecord {
  return { key: peer, latest: { createdAt, id: hex(createdAt + 500) }, mine: false };
}

function shard(deviceId: string, entry: DmConversationIndexRecord): DmConversationIndexShard {
  return {
    version: 1,
    deviceId,
    bucket: dmConversationIndexBucket(entry.key),
    records: [entry],
  };
}

function event(id: string, payload: DmConversationIndexShard, content?: string): NostrRumor {
  return {
    id,
    pubkey: SELF,
    kind: DM_CONVERSATIONS_EVENT_KIND,
    created_at: 100,
    content: content ?? serializeDmConversationIndexShard(payload),
    tags: [
      ["d", dmConversationIndexDTag(payload.deviceId, payload.bucket)],
      ["t", DM_CONVERSATIONS_EVENT_TAG],
    ],
  };
}

function signedEvent(payload: DmConversationIndexShard, createdAt: number): NostrEvent {
  return finalizeEvent({
    kind: DM_CONVERSATIONS_EVENT_KIND,
    created_at: createdAt,
    content: serializeDmConversationIndexShard(payload),
    tags: [
      ["d", dmConversationIndexDTag(payload.deviceId, payload.bucket)],
      ["t", DM_CONVERSATIONS_EVENT_TAG],
    ],
  }, SELF_SK);
}

function signer(decrypt: (content: string) => Promise<string>): NostrSigner {
  return {
    getPublicKey: async () => SELF,
    signEvent: vi.fn(),
    nip44: {
      encrypt: vi.fn(),
      decrypt: async (_pubkey: string, content: string) => decrypt(content),
    },
  } as unknown as NostrSigner;
}

beforeEach(async () => {
  localStorage.clear();
  await resetDmConversationIndexCache();
});

describe("DM conversation index decoding", () => {
  it("signs this installation's dirty local buckets for explicit Setup Sync", async () => {
    const entry = record(hex(8), 80);
    await recordDmConversationIndex(SELF, [entry]);
    const signEvent = vi.fn(async (template: Omit<NostrEvent, "id" | "pubkey" | "sig">) => ({
      ...template,
      id: "e".repeat(64),
      pubkey: SELF,
      sig: "1".repeat(128),
    }));
    const explicitSigner = {
      getPublicKey: async () => SELF,
      signEvent,
      nip44: {
        decrypt: async (_pubkey: string, content: string) => content,
        encrypt: async (_pubkey: string, content: string) => `encrypted:${content}`,
      },
    } as unknown as NostrSigner;

    const signed = await signCurrentDmConversationIndexEvents([], explicitSigner, SELF);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({
      pubkey: SELF,
      kind: 30078,
      content: expect.stringMatching(/^encrypted:/),
      tags: expect.arrayContaining([
        ["t", DM_CONVERSATIONS_EVENT_TAG],
      ]),
    });
    expect(signEvent).toHaveBeenCalledOnce();
  });

  it("rejects an invalidly signed relay result before winner selection", () => {
    const payload = shard("forged-device", record(hex(9), 9));
    const forged = {
      ...event(hex(99), payload),
      sig: "0".repeat(128),
    } as NostrEvent;
    const cached = event(hex(98), payload);

    expect(verifiedDmConversationIndexEvents([forged], [cached])).toEqual([cached]);
    expect(verifiedDmConversationIndexEvents([forged], [])).toEqual([]);
  });

  it("decrypts, validates and binds plaintext to its exact public coordinate", async () => {
    const payload = shard("phone-device", record(hex(1), 10));
    const valid = event(hex(101), payload);
    const mismatched = {
      ...event(hex(102), payload),
      tags: [
        ["d", dmConversationIndexDTag(payload.deviceId, (payload.bucket + 1) % 8)],
        ["t", DM_CONVERSATIONS_EVENT_TAG],
      ],
    };
    const result = await decodeDmConversationIndexEvents(
      [valid, mismatched],
      signer(async (content) => content),
      SELF,
    );

    expect(result.shards).toEqual([payload]);
    expect(result.heads.get(dmConversationIndexDTag(payload.deviceId, payload.bucket))?.event.id)
      .toBe(valid.id);
    expect(result.unreadable).toContain(mismatched.tags[0]![1]);
  });

  it("recovers the add-only union from divergent editions of one coordinate", async () => {
    const first = record(hex(10), 10);
    let secondSeed = 11;
    while (dmConversationIndexBucket(hex(secondSeed)) !== dmConversationIndexBucket(first.key)) {
      secondSeed++;
    }
    const second = record(hex(secondSeed), 20);
    const olderShard: DmConversationIndexShard = {
      version: 1,
      deviceId: "divergent-device",
      bucket: dmConversationIndexBucket(first.key),
      records: [first],
    };
    const newerShard: DmConversationIndexShard = {
      ...olderShard,
      records: [second],
    };
    const older = { ...event(hex(110), olderShard), created_at: 100 };
    const newer = { ...event(hex(111), newerShard), created_at: 200 };

    const result = await decodeDmConversationIndexEvents(
      [newer, older],
      signer(async (content) => content),
      SELF,
    );

    expect(result.shards).toHaveLength(1);
    expect(result.shards[0]?.records.map((entry) => entry.key).sort())
      .toEqual([first.key, second.key].sort());
    expect(result.heads.values().next().value?.event.id).toBe(newer.id);
    // The head stays the actual newer partial edition. Comparing it with the
    // hydrated union is what schedules a consolidating rewrite.
    expect(result.heads.values().next().value?.shard.records).toEqual([second]);
  });

  it("consolidates a departed device's newer partial and older richer copies", async () => {
    const first = record(hex(20), 20);
    let secondSeed = 21;
    while (dmConversationIndexBucket(hex(secondSeed)) !== dmConversationIndexBucket(first.key)) {
      secondSeed++;
    }
    const second = record(hex(secondSeed), 30);
    const deviceId = "departed-device";
    const olderShard: DmConversationIndexShard = {
      version: 1,
      deviceId,
      bucket: dmConversationIndexBucket(first.key),
      records: [first],
    };
    const newerShard = { ...olderShard, records: [second] };
    const signEvent = vi.fn(async (template: Omit<NostrEvent, "id" | "pubkey" | "sig">) => ({
      ...template,
      id: "e".repeat(64),
      pubkey: SELF,
      sig: "1".repeat(128),
    }));
    const explicitSigner = {
      getPublicKey: async () => SELF,
      signEvent,
      nip44: {
        decrypt: async (_pubkey: string, content: string) => content,
        encrypt: async (_pubkey: string, content: string) => `encrypted:${content}`,
      },
    } as unknown as NostrSigner;

    const signed = await signCurrentDmConversationIndexEvents([
      signedEvent(newerShard, 200),
      signedEvent(olderShard, 100),
    ], explicitSigner, SELF);

    expect(signed).toHaveLength(1);
    const plaintext = (signed[0]!.content).replace(/^encrypted:/, "");
    const consolidated = JSON.parse(plaintext) as DmConversationIndexShard;
    expect(consolidated.records.map((entry) => entry.key).sort())
      .toEqual([first.key, second.key].sort());
    expect(signed[0]!.created_at).toBeGreaterThan(200);
  });

  it("marks decrypt failures unreadable instead of treating the coordinate as absent", async () => {
    const payload = shard("desktop-device", record(hex(2), 20));
    const encrypted = event(hex(103), payload, "bad-ciphertext");
    const result = await decodeDmConversationIndexEvents(
      [encrypted],
      signer(async () => { throw new Error("denied"); }),
      SELF,
    );

    expect(result.shards).toEqual([]);
    expect(result.unreadable).toEqual(new Set([
      dmConversationIndexDTag(payload.deviceId, payload.bucket),
    ]));
  });

  it("serializes remote-signer decrypt requests rather than prompting in parallel", async () => {
    const first = shard("one-device", record(hex(3), 30));
    let secondPeer = 4;
    while (dmConversationIndexBucket(hex(secondPeer)) === first.bucket) secondPeer++;
    const second = shard("two-device", record(hex(secondPeer), 40));
    let active = 0;
    let maxActive = 0;
    const remoteSigner = signer(async (content) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return content;
    });

    const result = await decodeDmConversationIndexEvents(
      [event(hex(104), first), event(hex(105), second)],
      remoteSigner,
      SELF,
    );
    expect(result.shards).toHaveLength(2);
    expect(maxActive).toBe(1);
  });
});
