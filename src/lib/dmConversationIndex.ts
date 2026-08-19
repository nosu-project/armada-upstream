import type { NostrFilter } from "@nostrify/nostrify";

import type { NostrRumor } from "@/lib/nostrRumor";
import { APP_ID } from "@/lib/platform";

/** Encrypted NIP-78 application data, one addressable shard per installation. */
export const DM_CONVERSATIONS_EVENT_KIND = 30078;
/** Public discovery tag. It deliberately reveals no peer or conversation id. */
export const DM_CONVERSATIONS_EVENT_TAG = "armada-dm-conversations";
/** Fork-safe address prefix. The opaque installation id is appended. */
export const DM_CONVERSATIONS_D_PREFIX = `${APP_ID}/dm-conversations/`;
export const DM_CONVERSATIONS_SYNC_QUERY_KEY = ["dm-conversations-sync"] as const;

/** Bounds keep a self-signed but corrupt shard from consuming unbounded work. */
export const DM_CONVERSATION_INDEX_BUCKETS = 8;
export const MAX_DM_CONVERSATIONS_PER_SHARD = 400;
export const MAX_MERGED_DM_CONVERSATIONS = 2_000;
export const MAX_DM_CONVERSATION_PARTICIPANTS = 32;
export const MAX_DM_CONVERSATION_SHARDS = 128;
export const MAX_DM_CONVERSATION_EVENT_CANDIDATES = 256;
export const MAX_DM_CONVERSATION_VERSIONS_PER_SHARD = 16;
export const MAX_DM_CONVERSATION_PLAINTEXT_BYTES = 64 * 1024;
export const MAX_DM_CONVERSATION_CIPHERTEXT_CHARS = 96 * 1024;

const HEX_64 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface DmConversationLatest {
  createdAt: number;
  id: string;
}

/**
 * The durable facts needed to rediscover a row. Message text, read state,
 * request state, pins and close markers intentionally live elsewhere.
 */
export interface DmConversationIndexRecord {
  key: string;
  latest: DmConversationLatest;
  /** Sticky evidence that this account has participated in the conversation. */
  mine: boolean;
}

export interface DmConversationIndexShard {
  version: 1;
  deviceId: string;
  /** Stable hash bucket. Only this opaque number appears in the public d tag. */
  bucket: number;
  records: DmConversationIndexRecord[];
}

/** A canonical NIP-17 conversation key is a sorted, unique pubkey set. */
export function isCanonicalDmConversationKey(key: string): boolean {
  if (!key || key.length > MAX_DM_CONVERSATION_PARTICIPANTS * 65) return false;
  const peers = key.split(",");
  if (peers.length < 1 || peers.length > MAX_DM_CONVERSATION_PARTICIPANTS) return false;
  if (peers.some((peer) => !HEX_64.test(peer))) return false;
  if (new Set(peers).size !== peers.length) return false;
  return peers.every((peer, index) => index === 0 || peers[index - 1]! < peer);
}

export function isDmConversationDeviceId(deviceId: string): boolean {
  return DEVICE_ID.test(deviceId);
}

/** Stable non-cryptographic distribution; peer material never appears in tags. */
export function dmConversationIndexBucket(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % DM_CONVERSATION_INDEX_BUCKETS;
}

function isBucket(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 0
    && (value as number) < DM_CONVERSATION_INDEX_BUCKETS;
}

function isLatest(value: unknown): value is DmConversationLatest {
  if (!value || typeof value !== "object") return false;
  const latest = value as Partial<DmConversationLatest>;
  return Number.isSafeInteger(latest.createdAt)
    && (latest.createdAt ?? -1) >= 0
    && typeof latest.id === "string"
    && HEX_64.test(latest.id);
}

export function isDmConversationIndexRecord(value: unknown): value is DmConversationIndexRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DmConversationIndexRecord>;
  return typeof record.key === "string"
    && isCanonicalDmConversationKey(record.key)
    && isLatest(record.latest)
    && typeof record.mine === "boolean";
}

/** Deterministic winner for the newest known message marker. */
function recordWins(
  candidate: DmConversationIndexRecord,
  current: DmConversationIndexRecord | undefined,
): boolean {
  return !current
    || candidate.latest.createdAt > current.latest.createdAt
    || (candidate.latest.createdAt === current.latest.createdAt
      && candidate.latest.id > current.latest.id);
}

/**
 * Add-only union keyed by canonical participant set. `mine` is monotonic and
 * therefore merged independently of which latest-message marker wins.
 */
export function mergeDmConversationIndexRecords(
  sets: readonly (readonly DmConversationIndexRecord[])[],
  limit = MAX_MERGED_DM_CONVERSATIONS,
): DmConversationIndexRecord[] {
  const merged = new Map<string, DmConversationIndexRecord>();
  for (const records of sets) {
    for (const candidate of records) {
      if (!isDmConversationIndexRecord(candidate)) continue;
      const current = merged.get(candidate.key);
      const winner = recordWins(candidate, current) ? candidate : current!;
      merged.set(candidate.key, {
        key: winner.key,
        latest: { ...winner.latest },
        mine: candidate.mine || (current?.mine ?? false),
      });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt
      || b.latest.id.localeCompare(a.latest.id)
      || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, limit));
}

/** Strictly validate and canonicalise decrypted/local input. */
export function parseDmConversationIndexShard(value: unknown): DmConversationIndexShard | null {
  if (!value || typeof value !== "object") return null;
  const shard = value as Partial<DmConversationIndexShard>;
  if (
    shard.version !== 1
    || typeof shard.deviceId !== "string"
    || !isDmConversationDeviceId(shard.deviceId)
    || !isBucket(shard.bucket)
    || !Array.isArray(shard.records)
    || shard.records.length > MAX_DM_CONVERSATIONS_PER_SHARD
    || shard.records.some((record) => !isDmConversationIndexRecord(record))
    || shard.records.some((record) => dmConversationIndexBucket(record.key) !== shard.bucket)
  ) {
    return null;
  }
  return {
    version: 1,
    deviceId: shard.deviceId,
    bucket: shard.bucket,
    records: mergeDmConversationIndexRecords(
      [shard.records],
      MAX_DM_CONVERSATIONS_PER_SHARD,
    ),
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Produce the canonical bounded payload used both on disk and on the wire.
 * Very large group keys can hit the byte bound before the record-count bound;
 * oldest rows are the deterministic eviction edge in either case.
 */
export function fitDmConversationIndexShard(
  deviceId: string,
  bucket: number,
  records: readonly DmConversationIndexRecord[],
): DmConversationIndexShard {
  if (!isDmConversationDeviceId(deviceId)) throw new Error("Invalid DM index device id");
  if (!isBucket(bucket)) throw new Error("Invalid DM index bucket");
  const canonical = mergeDmConversationIndexRecords(
    [records.filter((record) => dmConversationIndexBucket(record.key) === bucket)],
    MAX_DM_CONVERSATIONS_PER_SHARD,
  );
  const shard: DmConversationIndexShard = { version: 1, deviceId, bucket, records: canonical };
  while (
    shard.records.length > 0
    && utf8Bytes(JSON.stringify(shard)) > MAX_DM_CONVERSATION_PLAINTEXT_BYTES
  ) {
    shard.records.pop();
  }
  return shard;
}

export function serializeDmConversationIndexShard(shard: DmConversationIndexShard): string {
  const fitted = fitDmConversationIndexShard(shard.deviceId, shard.bucket, shard.records);
  return JSON.stringify(fitted);
}

/** Decode a plaintext only after enforcing its byte and schema bounds. */
export function parseDmConversationIndexPlaintext(
  plaintext: string,
): DmConversationIndexShard | null {
  if (utf8Bytes(plaintext) > MAX_DM_CONVERSATION_PLAINTEXT_BYTES) return null;
  try {
    return parseDmConversationIndexShard(JSON.parse(plaintext));
  } catch {
    return null;
  }
}

export function dmConversationIndexDTag(deviceId: string, bucket: number): string {
  if (!isDmConversationDeviceId(deviceId)) throw new Error("Invalid DM index device id");
  if (!isBucket(bucket)) throw new Error("Invalid DM index bucket");
  return `${DM_CONVERSATIONS_D_PREFIX}${deviceId}/${bucket}`;
}

export function parseDmConversationIndexDTag(
  identifier: string,
): { deviceId: string; bucket: number } | null {
  if (!identifier.startsWith(DM_CONVERSATIONS_D_PREFIX)) return null;
  const suffix = identifier.slice(DM_CONVERSATIONS_D_PREFIX.length);
  const slash = suffix.lastIndexOf("/");
  if (slash <= 0) return null;
  const deviceId = suffix.slice(0, slash);
  const bucketText = suffix.slice(slash + 1);
  if (!isDmConversationDeviceId(deviceId) || !/^\d+$/.test(bucketText)) return null;
  const bucket = Number(bucketText);
  if (!isBucket(bucket) || identifier !== dmConversationIndexDTag(deviceId, bucket)) return null;
  return { deviceId, bucket };
}

export function dmConversationIndexFilter(pubkey: string): NostrFilter {
  return {
    kinds: [DM_CONVERSATIONS_EVENT_KIND],
    authors: [pubkey],
    "#t": [DM_CONVERSATIONS_EVENT_TAG],
    limit: MAX_DM_CONVERSATION_SHARDS,
  };
}

function tagValue(event: NostrRumor, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/** NIP-01 addressable tie-break: newer timestamp, then lowest event id. */
function eventWins(candidate: NostrRumor, current: NostrRumor | undefined): boolean {
  return !current
    || candidate.created_at > current.created_at
    || (candidate.created_at === current.created_at && candidate.id < current.id);
}

/**
 * Select one bounded winner per valid installation coordinate before doing any
 * potentially interactive NIP-44 work.
 */
export function newestDmConversationIndexEvents(
  events: readonly NostrRumor[],
  pubkey: string,
): NostrRumor[] {
  return dmConversationIndexEventGroups(events, pubkey).map((group) => group[0]!);
}

/**
 * Bounded editions grouped per addressable coordinate, newest first. Relays
 * can legitimately disagree about a replaceable event; callers merge every
 * decrypted edition and use only the first item as the NIP-01 head.
 */
export function dmConversationIndexEventGroups(
  events: readonly NostrRumor[],
  pubkey: string,
): NostrRumor[][] {
  const valid = new Map<string, NostrRumor>();
  for (const event of events) {
    if (
      event.kind !== DM_CONVERSATIONS_EVENT_KIND
      || event.pubkey !== pubkey
      || event.content.length > MAX_DM_CONVERSATION_CIPHERTEXT_CHARS
      || !event.tags.some((tag) => tag[0] === "t" && tag[1] === DM_CONVERSATIONS_EVENT_TAG)
    ) continue;
    const d = tagValue(event, "d");
    if (!d || !parseDmConversationIndexDTag(d)) continue;
    valid.set(event.id, event);
  }
  const ordered = [...valid.values()]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  const groups = new Map<string, NostrRumor[]>();
  let admitted = 0;
  for (const event of ordered) {
    if (admitted >= MAX_DM_CONVERSATION_EVENT_CANDIDATES) break;
    const d = tagValue(event, "d")!;
    let group = groups.get(d);
    if (!group) {
      if (groups.size >= MAX_DM_CONVERSATION_SHARDS) continue;
      group = [];
      groups.set(d, group);
    }
    if (group.length >= MAX_DM_CONVERSATION_VERSIONS_PER_SHARD) continue;
    group.push(event);
    admitted++;
  }
  return [...groups.values()].sort((left, right) => {
    const a = left[0]!;
    const b = right[0]!;
    return eventWins(a, b) ? -1 : eventWins(b, a) ? 1 : 0;
  });
}
