import { useSyncExternalStore } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { KvPrefixCache } from "@/lib/db/kvCache";
import {
  DM_CONVERSATION_INDEX_BUCKETS,
  dmConversationIndexBucket,
  fitDmConversationIndexBucket,
  isDmConversationIndexRecord,
  MAX_MERGED_DM_CONVERSATIONS,
  mergeDmConversationIndexRecords,
  type DmConversationIndexBucketDoc,
  type DmConversationIndexRecord,
} from "@/lib/dmConversationIndex";

const MERGED_STORE_PREFIX = "dm-conversations-merged:";

/**
 * The account's whole index, as this device knows it. It is also what this device
 * publishes: the eight shared bucket documents are this set, split by bucket.
 */
const mergedStore = new KvPrefixCache<unknown>({ prefix: MERGED_STORE_PREFIX });

const mergedCache = new Map<string, DmConversationIndexRecord[]>();
const snapshotCache = new Map<string, DmConversationIndexRecord[]>();
const listeners = new Set<() => void>();
const dirtyListeners = new Set<(pubkey: string, buckets: readonly number[]) => void>();
const EMPTY: DmConversationIndexRecord[] = [];
let warmPromise: Promise<void> | undefined;

function notify(): void {
  snapshotCache.clear();
  for (const listener of listeners) listener();
}

export function readyDmConversationIndex(): Promise<void> {
  if (mergedStore.warmed) return Promise.resolve();
  warmPromise ??= mergedStore.ready().then(() => {
    mergedCache.clear();
    snapshotCache.clear();
    notify();
  }).finally(() => {
    warmPromise = undefined;
  });
  return warmPromise;
}

function loadMerged(pubkey: string): DmConversationIndexRecord[] {
  const held = mergedCache.get(pubkey);
  if (held) return held;
  const stored = mergedStore.get(pubkey);
  const records = mergeDmConversationIndexRecords(
    [Array.isArray(stored) ? stored.filter(isDmConversationIndexRecord) : []],
    MAX_MERGED_DM_CONVERSATIONS,
  );
  if (mergedStore.warmed) mergedCache.set(pubkey, records);
  return records;
}

async function saveMerged(
  pubkey: string,
  records: readonly DmConversationIndexRecord[],
): Promise<void> {
  const next = mergeDmConversationIndexRecords([records], MAX_MERGED_DM_CONVERSATIONS);
  mergedCache.set(pubkey, next);
  mergedStore.set(pubkey, next);
  // Awaited too: this is the durable dirty state if a publish never lands.
  await getArmadaDB().kv.set(`${MERGED_STORE_PREFIX}${pubkey}`, next).catch(() => undefined);
}

function bucketsOf(records: readonly DmConversationIndexRecord[]): Set<number> {
  return new Set(records.map((record) => dmConversationIndexBucket(record.key)));
}

/** Records whose addition changes `bucket`'s published form. */
function changedBuckets(
  before: readonly DmConversationIndexRecord[],
  after: readonly DmConversationIndexRecord[],
  candidates: Iterable<number>,
): number[] {
  const changed: number[] = [];
  for (const bucket of candidates) {
    const a = fitDmConversationIndexBucket(bucket, before);
    const b = fitDmConversationIndexBucket(bucket, after);
    if (JSON.stringify(a.records) !== JSON.stringify(b.records)) changed.push(bucket);
  }
  return changed;
}

export async function getDmConversationIndexRecords(
  pubkey: string,
): Promise<DmConversationIndexRecord[]> {
  await readyDmConversationIndex();
  return loadMerged(pubkey);
}

/** The eight documents this device would publish, from what it knows. */
export async function dmConversationIndexBuckets(
  pubkey: string,
): Promise<DmConversationIndexBucketDoc[]> {
  const records = await getDmConversationIndexRecords(pubkey);
  return Array.from(
    { length: DM_CONVERSATION_INDEX_BUCKETS },
    (_, bucket) => fitDmConversationIndexBucket(bucket, records),
  );
}

/** Main-inbox rows only (classified by DMsPage); never request-tier rows. Marks buckets dirty. */
export async function recordDmConversationIndex(
  pubkey: string,
  records: readonly DmConversationIndexRecord[],
): Promise<boolean> {
  await readyDmConversationIndex();
  const valid = records.filter(isDmConversationIndexRecord);
  if (valid.length === 0) return false;
  const previous = loadMerged(pubkey);
  const next = mergeDmConversationIndexRecords([previous, valid], MAX_MERGED_DM_CONVERSATIONS);
  const dirty = changedBuckets(previous, next, bucketsOf(valid));
  if (dirty.length === 0) return false;
  await saveMerged(pubkey, next);
  notify();
  for (const listener of dirtyListeners) listener(pubkey, dirty);
  return true;
}

/** Fold remote records in. Not a local edit: whether to republish is the sync's call. */
export async function hydrateDmConversationIndexRecords(
  pubkey: string,
  sets: readonly (readonly DmConversationIndexRecord[])[],
): Promise<void> {
  await readyDmConversationIndex();
  const previous = loadMerged(pubkey);
  const next = mergeDmConversationIndexRecords([previous, ...sets], MAX_MERGED_DM_CONVERSATIONS);
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  await saveMerged(pubkey, next);
  notify();
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
  if (!mergedStore.warmed) {
    void readyDmConversationIndex();
    return EMPTY;
  }
  const records = loadMerged(pubkey);
  snapshotCache.set(pubkey, records);
  return records;
}

/** Network ownership lives in NostrSync. */
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

export function useDmConversationIndexReady(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void readyDmConversationIndex();
      return () => listeners.delete(listener);
    },
    () => mergedStore.warmed,
    () => false,
  );
}

/** Test seam; account data is normally cleared by ArmadaDB logout. */
export async function resetDmConversationIndexCache(): Promise<void> {
  mergedCache.clear();
  snapshotCache.clear();
  await mergedStore.clear();
}
