import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import type { NostrEvent, NostrSigner } from "@nostrify/nostrify";

import {
  decodeDmConversationIndexEvents,
  signCurrentDmConversationIndexEvents,
  signDmConversationIndexBucket,
  verifiedDmConversationIndexEvents,
} from "@/hooks/useDmConversationIndexSync";
import {
  getDmConversationIndexRecords,
  recordDmConversationIndex,
  resetDmConversationIndexCache,
} from "@/hooks/useDmConversationIndex";
import {
  DM_CONVERSATIONS_EVENT_KIND,
  DM_CONVERSATIONS_EVENT_TAG,
  dmConversationIndexBucket,
  dmConversationIndexDTag,
  fitDmConversationIndexBucket,
  serializeDmConversationIndexShard,
  type DmConversationIndexBucketDoc,
  type DmConversationIndexRecord,
  type DmConversationIndexShard,
} from "@/lib/dmConversationIndex";
import type { NostrRumor } from "@/lib/nostrRumor";
import { settingsKeyring } from "@/lib/settingsKeys";

const SELF_SK = new Uint8Array(32).fill(7);
const SELF = getPublicKey(SELF_SK);
const KEYRING = settingsKeyring("04".repeat(32));
const KEYS = { keyring: KEYRING, previous: [] };

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

/** A legacy, account-signed per-installation shard. */
function legacyEvent(id: string, payload: DmConversationIndexShard, createdAt = 100): NostrRumor {
  return {
    id,
    pubkey: SELF,
    kind: DM_CONVERSATIONS_EVENT_KIND,
    created_at: createdAt,
    content: serializeDmConversationIndexShard(payload),
    tags: [
      ["d", dmConversationIndexDTag(payload.deviceId, payload.bucket)],
      ["t", DM_CONVERSATIONS_EVENT_TAG],
    ],
  };
}

function signedLegacyEvent(payload: DmConversationIndexShard, createdAt: number): NostrEvent {
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

function derivedEvent(bucket: DmConversationIndexBucketDoc, createdAt: number): Promise<NostrEvent> {
  // Stamped at max(now, createdAt): signed, so the stamp cannot be edited afterwards.
  return signDmConversationIndexBucket(KEYRING.dmConversations[bucket.bucket]!, bucket, createdAt - 1);
}

async function decryptDerived(event: NostrEvent): Promise<DmConversationIndexBucketDoc> {
  const doc = KEYRING.byPubkey.get(event.pubkey)!;
  return JSON.parse(await doc.signer.nip44!.decrypt(doc.pubkey, event.content));
}

/** The account signer, with an identity "encryption" for the legacy shards. */
function signer(decrypt: (content: string) => Promise<string> = async (content) => content): NostrSigner {
  return {
    getPublicKey: async () => SELF,
    signEvent: vi.fn(async () => {
      throw new Error("the account key must not sign a derived document");
    }),
    nip44: {
      encrypt: vi.fn(),
      decrypt: async (_pubkey: string, content: string) => decrypt(content),
    },
  } as unknown as NostrSigner;
}

function sameBucketPeer(first: string, from: number): string {
  let seed = from;
  while (dmConversationIndexBucket(hex(seed)) !== dmConversationIndexBucket(first)) seed++;
  return hex(seed);
}

beforeEach(async () => {
  localStorage.clear();
  await resetDmConversationIndexCache();
});

describe("DM conversation index decoding", () => {
  it("signs dirty local buckets under their derived keys for explicit Setup Sync", async () => {
    const entry = record(hex(8), 80);
    await recordDmConversationIndex(SELF, [entry]);

    const signed = await signCurrentDmConversationIndexEvents([], { signer: signer(), pubkey: SELF, keys: KEYS });
    expect(signed).toHaveLength(1);
    const bucket = dmConversationIndexBucket(entry.key);
    expect(signed[0]).toMatchObject({
      pubkey: KEYRING.dmConversations[bucket]!.pubkey,
      kind: 30078,
      tags: [["d", KEYRING.dmConversations[bucket]!.d]],
    });
    expect(await decryptDerived(signed[0]!)).toEqual({ version: 2, bucket, records: [entry] });
  });

  it("rejects an invalidly signed relay result before winner selection", () => {
    const payload = shard("forged-device", record(hex(9), 9));
    const forged = {
      ...legacyEvent(hex(99), payload),
      sig: "0".repeat(128),
    } as NostrEvent;
    const cached = legacyEvent(hex(98), payload);

    expect(verifiedDmConversationIndexEvents([forged], [cached])).toEqual([cached]);
    expect(verifiedDmConversationIndexEvents([forged], [])).toEqual([]);
  });

  it("binds a legacy plaintext to its exact public coordinate", async () => {
    const payload = shard("phone-device", record(hex(1), 10));
    const valid = legacyEvent(hex(101), payload);
    const mismatched = {
      ...legacyEvent(hex(102), payload),
      tags: [
        ["d", dmConversationIndexDTag(payload.deviceId, (payload.bucket + 1) % 8)],
        ["t", DM_CONVERSATIONS_EVENT_TAG],
      ],
    };
    const result = await decodeDmConversationIndexEvents(
      [valid, mismatched],
      { signer: signer(), pubkey: SELF, keys: KEYS },
    );
    expect(result.sets).toEqual([payload.records]);
  });

  it("binds a derived bucket document to its own bucket", async () => {
    const entry = record(hex(30), 30);
    const bucket = dmConversationIndexBucket(entry.key);
    const valid = await derivedEvent(fitDmConversationIndexBucket(bucket, [entry]), 300);
    // A payload naming another bucket, signed under this bucket's key.
    const wrong = await signDmConversationIndexBucket(
      KEYRING.dmConversations[(bucket + 1) % 8]!,
      { version: 2, bucket, records: [entry] },
      0,
    );
    const result = await decodeDmConversationIndexEvents(
      [valid, wrong],
      { signer: signer(), pubkey: SELF, keys: KEYS },
    );
    expect(result.heads.get(bucket)?.event.id).toBe(valid.id);
    expect(result.unreadable).toEqual(new Set([(bucket + 1) % 8]));
  });

  it("folds legacy installations' shards and a partial derived head into one document", async () => {
    const first = record(hex(20), 20);
    const second = record(sameBucketPeer(first.key, 21), 30);
    const third = record(sameBucketPeer(first.key, Number.parseInt(second.key, 16) + 1), 40);
    const bucket = dmConversationIndexBucket(first.key);
    const head = await derivedEvent(fitDmConversationIndexBucket(bucket, [third]), 500);

    const signed = await signCurrentDmConversationIndexEvents([
      signedLegacyEvent(shard("departed-device", first), 200),
      signedLegacyEvent(shard("phone-device", second), 100),
      head,
    ], { signer: signer(), pubkey: SELF, keys: KEYS });

    expect(signed).toHaveLength(1);
    const consolidated = await decryptDerived(signed[0]!);
    expect(consolidated.records.map((entry) => entry.key).sort())
      .toEqual([first.key, second.key, third.key].sort());
    expect(signed[0]!.created_at).toBeGreaterThan(head.created_at);
    expect((await getDmConversationIndexRecords(SELF)).length).toBe(3);
  });

  it("never overwrites a derived head it cannot read", async () => {
    const entry = record(hex(40), 40);
    await recordDmConversationIndex(SELF, [entry]);
    const bucket = dmConversationIndexBucket(entry.key);
    const doc = KEYRING.dmConversations[bucket]!;
    const unreadable = await doc.signer.signEvent({
      kind: DM_CONVERSATIONS_EVENT_KIND,
      content: "not-ciphertext",
      tags: [["d", doc.d]],
      created_at: 100,
    });
    await expect(signCurrentDmConversationIndexEvents([unreadable], { signer: signer(), pubkey: SELF, keys: KEYS }))
      .rejects.toThrow(/could not be decrypted/);
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
      [legacyEvent(hex(104), first), legacyEvent(hex(105), second)],
      { signer: remoteSigner, pubkey: SELF, keys: KEYS },
    );
    expect(result.sets).toHaveLength(2);
    expect(maxActive).toBe(1);
  });
});
