import { useSyncExternalStore } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { KvPrefixCache } from "@/lib/db/kvCache";
import {
  DM_CONVERSATION_INDEX_BUCKETS,
  dmConversationIndexBucket,
  fitDmConversationIndexShard,
  isDmConversationIndexRecord,
  isDmConversationDeviceId,
  MAX_MERGED_DM_CONVERSATIONS,
  mergeDmConversationIndexRecords,
  parseDmConversationIndexShard,
  type DmConversationIndexRecord,
  type DmConversationIndexShard,
} from "@/lib/dmConversationIndex";
import { APP_ID } from "@/lib/platform";

const DEVICE_ID_PREFIX = `${APP_ID}:dm-conversations:device-id:`;
const SHARD_STORE_PREFIX = "dm-conversations-shard:";
const MERGED_STORE_PREFIX = "dm-conversations-merged:";

const shardStore = new KvPrefixCache<unknown>({ prefix: SHARD_STORE_PREFIX });
const mergedStore = new KvPrefixCache<unknown>({ prefix: MERGED_STORE_PREFIX });

const ownShardCache = new Map<string, Map<number, DmConversationIndexShard>>();
const mergedCache = new Map<string, DmConversationIndexRecord[]>();
const snapshotCache = new Map<string, DmConversationIndexRecord[]>();
const deviceIdMemory = new Map<string, string>();
const listeners = new Set<() => void>();
const dirtyListeners = new Set<(pubkey: string, buckets: readonly number[]) => void>();
const EMPTY: DmConversationIndexRecord[] = [];
let warmPromise: Promise<void> | undefined;

function notify(): void {
  snapshotCache.clear();
  for (const listener of listeners) listener();
}

/** Warm the async ArmadaDB-backed caches before any read-modify-write. */
export function readyDmConversationIndex(): Promise<void> {
  if (shardStore.warmed && mergedStore.warmed) return Promise.resolve();
  warmPromise ??= Promise.all([shardStore.ready(), mergedStore.ready()]).then(() => {
    ownShardCache.clear();
    mergedCache.clear();
    snapshotCache.clear();
    notify();
  }).finally(() => {
    warmPromise = undefined;
  });
  return warmPromise;
}

function randomDeviceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
    .slice(0, 64);
}

/** Stable, opaque installation id; account-scoped so account switching cannot alias shards. */
export function dmConversationDeviceId(pubkey: string): string {
  const held = deviceIdMemory.get(pubkey);
  if (held) return held;
  const key = `${DEVICE_ID_PREFIX}${pubkey}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing && isDmConversationDeviceId(existing)) {
      deviceIdMemory.set(pubkey, existing);
      return existing;
    }
    const created = randomDeviceId();
    localStorage.setItem(key, created);
    deviceIdMemory.set(pubkey, created);
    return created;
  } catch {
    const created = randomDeviceId();
    deviceIdMemory.set(pubkey, created);
    return created;
  }
}

function ownShardStoreId(pubkey: string, bucket: number): string {
  return `${pubkey}:${dmConversationDeviceId(pubkey)}:${bucket}`;
}

function loadOwn(pubkey: string, bucket: number): DmConversationIndexShard {
  const held = ownShardCache.get(pubkey)?.get(bucket);
  if (held) return held;
  const deviceId = dmConversationDeviceId(pubkey);
  const parsed = parseDmConversationIndexShard(shardStore.get(ownShardStoreId(pubkey, bucket)));
  const shard = parsed?.deviceId === deviceId && parsed.bucket === bucket
    ? parsed
    : { version: 1, deviceId, bucket, records: [] } satisfies DmConversationIndexShard;
  if (shardStore.warmed) {
    const byBucket = ownShardCache.get(pubkey) ?? new Map();
    byBucket.set(bucket, shard);
    ownShardCache.set(pubkey, byBucket);
  }
  return shard;
}

function loadOwnShards(pubkey: string): DmConversationIndexShard[] {
  return Array.from(
    { length: DM_CONVERSATION_INDEX_BUCKETS },
    (_, bucket) => loadOwn(pubkey, bucket),
  );
}

function loadMerged(pubkey: string): DmConversationIndexRecord[] {
  const held = mergedCache.get(pubkey);
  if (held) return held;
  const stored = mergedStore.get(pubkey);
  const storedRecords = Array.isArray(stored)
    ? stored.filter(isDmConversationIndexRecord)
    : [];
  const records = mergeDmConversationIndexRecords(
    [storedRecords, ...loadOwnShards(pubkey).map((shard) => shard.records)],
    MAX_MERGED_DM_CONVERSATIONS,
  );
  if (mergedStore.warmed && shardStore.warmed) mergedCache.set(pubkey, records);
  return records;
}

async function saveOwn(pubkey: string, shard: DmConversationIndexShard): Promise<void> {
  const fitted = fitDmConversationIndexShard(shard.deviceId, shard.bucket, shard.records);
  const byBucket = ownShardCache.get(pubkey) ?? new Map();
  byBucket.set(shard.bucket, fitted);
  ownShardCache.set(pubkey, byBucket);
  const id = ownShardStoreId(pubkey, shard.bucket);
  shardStore.set(id, fitted);
  // KvPrefixCache writes through for ordinary cache users. Await a direct copy
  // here as well: this shard is the durable dirty state after signer refusal.
  await getArmadaDB().kv.set(`${SHARD_STORE_PREFIX}${id}`, fitted).catch(() => undefined);
}

async function saveMerged(
  pubkey: string,
  records: readonly DmConversationIndexRecord[],
): Promise<void> {
  const next = mergeDmConversationIndexRecords([records], MAX_MERGED_DM_CONVERSATIONS);
  mergedCache.set(pubkey, next);
  mergedStore.set(pubkey, next);
  await getArmadaDB().kv.set(`${MERGED_STORE_PREFIX}${pubkey}`, next).catch(() => undefined);
}

function sameRecords(
  left: readonly DmConversationIndexRecord[],
  right: readonly DmConversationIndexRecord[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Current durable union, newest first. */
export async function getDmConversationIndexRecords(
  pubkey: string,
): Promise<DmConversationIndexRecord[]> {
  await readyDmConversationIndex();
  return loadMerged(pubkey);
}

export async function loadOwnDmConversationIndexShards(
  pubkey: string,
): Promise<DmConversationIndexShard[]> {
  await readyDmConversationIndex();
  return loadOwnShards(pubkey);
}

/**
 * Record only rows already classified into the main inbox by DMsPage. Callers
 * must not pass request-tier rows; validation here supplies a second boundary.
 */
export async function recordDmConversationIndex(
  pubkey: string,
  records: readonly DmConversationIndexRecord[],
): Promise<boolean> {
  await readyDmConversationIndex();
  const valid = records.filter(isDmConversationIndexRecord);
  if (valid.length === 0) return false;

  const byBucket = new Map<number, DmConversationIndexRecord[]>();
  for (const record of valid) {
    const bucket = dmConversationIndexBucket(record.key);
    const held = byBucket.get(bucket) ?? [];
    held.push(record);
    byBucket.set(bucket, held);
  }
  const changedBuckets: number[] = [];
  const changedRecords: DmConversationIndexRecord[][] = [];
  for (const [bucket, additions] of byBucket) {
    const previousOwn = loadOwn(pubkey, bucket);
    const nextOwn = fitDmConversationIndexShard(
      previousOwn.deviceId,
      bucket,
      mergeDmConversationIndexRecords([previousOwn.records, additions]),
    );
    if (sameRecords(previousOwn.records, nextOwn.records)) continue;
    await saveOwn(pubkey, nextOwn);
    changedBuckets.push(bucket);
    changedRecords.push(nextOwn.records);
  }
  if (changedBuckets.length === 0) return false;

  await saveMerged(pubkey, mergeDmConversationIndexRecords([loadMerged(pubkey), ...changedRecords]));
  notify();
  for (const listener of dirtyListeners) listener(pubkey, changedBuckets);
  return true;
}

/** Fold valid remote installation shards into the local add-only union. */
export async function hydrateDmConversationIndexShards(
  pubkey: string,
  shards: readonly DmConversationIndexShard[],
): Promise<void> {
  await readyDmConversationIndex();
  const valid = shards
    .map(parseDmConversationIndexShard)
    .filter((shard): shard is DmConversationIndexShard => shard !== null);
  if (valid.length === 0) return;

  const deviceId = dmConversationDeviceId(pubkey);
  const nextOwnShards: DmConversationIndexShard[] = [];
  for (let bucket = 0; bucket < DM_CONVERSATION_INDEX_BUCKETS; bucket++) {
    const previousOwn = loadOwn(pubkey, bucket);
    const remoteOwn = valid.filter(
      (shard) => shard.deviceId === deviceId && shard.bucket === bucket,
    );
    const nextOwn = fitDmConversationIndexShard(
      deviceId,
      bucket,
      mergeDmConversationIndexRecords([
        previousOwn.records,
        ...remoteOwn.map((shard) => shard.records),
      ]),
    );
    if (!sameRecords(previousOwn.records, nextOwn.records)) await saveOwn(pubkey, nextOwn);
    nextOwnShards.push(nextOwn);
  }

  const previousMerged = loadMerged(pubkey);
  const nextMerged = mergeDmConversationIndexRecords([
    previousMerged,
    ...nextOwnShards.map((shard) => shard.records),
    ...valid.map((shard) => shard.records),
  ]);
  if (sameRecords(previousMerged, nextMerged)) return;
  await saveMerged(pubkey, nextMerged);
  notify();
}

/** Compare canonical contents, not event ids, after the pull-before-publish merge. */
export async function ownDmConversationIndexNeedsPublish(
  pubkey: string,
  remoteOwn: ReadonlyMap<number, DmConversationIndexShard>,
): Promise<number[]> {
  const ownShards = await loadOwnDmConversationIndexShards(pubkey);
  const dirty: number[] = [];
  for (const own of ownShards) {
    if (own.records.length === 0) continue;
    const remote = remoteOwn.get(own.bucket);
    if (!remote || remote.deviceId !== own.deviceId || !sameRecords(
      own.records,
      fitDmConversationIndexShard(remote.deviceId, remote.bucket, remote.records).records,
    )) dirty.push(own.bucket);
  }
  return dirty;
}

export function subscribeDmConversationIndexChanges(
  listener: (pubkey: string, buckets: readonly number[]) => void,
): () => void {
  dirtyListeners.add(listener);
  return () => dirtyListeners.delete(listener);
}

function snapshot(pubkey: string | undefined): DmConversationIndexRecord[] {
  if (!pubkey) return EMPTY;
  const held = snapshotCache.get(pubkey);
  if (held) return held;
  if (!shardStore.warmed || !mergedStore.warmed) {
    void readyDmConversationIndex();
    return EMPTY;
  }
  const records = loadMerged(pubkey);
  snapshotCache.set(pubkey, records);
  return records;
}

/** Local account-scoped roster; network ownership lives in NostrSync. */
export function useDmConversationIndex(): DmConversationIndexRecord[] {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot(pubkey),
    () => EMPTY,
  );
}

/** True once the local ArmadaDB index has finished its cold-start warm. */
export function useDmConversationIndexReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void readyDmConversationIndex();
      return () => listeners.delete(listener);
    },
    () => shardStore.warmed && mergedStore.warmed,
    () => false,
  );
}

/** Test seam; account data itself is normally cleared by ArmadaDB logout. */
export async function resetDmConversationIndexCache(): Promise<void> {
  ownShardCache.clear();
  mergedCache.clear();
  snapshotCache.clear();
  deviceIdMemory.clear();
  await Promise.all([shardStore.clear(), mergedStore.clear()]);
}
