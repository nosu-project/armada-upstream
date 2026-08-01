import { useCallback, useSyncExternalStore } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { GifResult } from "@/hooks/useGifSearch";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { KIND_APP_SPECIFIC, T_ARMADA_GIF_FAVORITES } from "@/lib/selfSyncKinds";

/** Legacy, device-wide favorites written by Armada before account sync existed. */
export const LEGACY_FAVORITE_GIFS_KEY = "armada:favorite-gifs";
export const FAVORITE_GIFS_EVENT_KIND = KIND_APP_SPECIFIC;
export const FAVORITE_GIFS_EVENT_TAG = T_ARMADA_GIF_FAVORITES;
export const FAVORITE_GIFS_D_PREFIX = "armada/gif-favorites/";

/**
 * The device id stays in localStorage, deliberately, unlike the shards below.
 * It is 36 bytes, and it has to be readable SYNCHRONOUSLY: `ownShardKey`
 * embeds it, so an async read that came back empty would mint a second id and
 * fork this installation's shard in two.
 */
const DEVICE_ID_PREFIX = "armada:favorite-gifs:device-id:";

/**
 * The shards themselves are in ArmadaDB's KV — unbounded with the number of
 * favorites, tens of KB each, and both writes swallowed quota failures.
 *
 * Two caches rather than one over `armada:favorite-gifs:`, so the localStorage
 * move (`LOCALSTORAGE_MOVES`) names the shard and merge spaces exactly and
 * cannot reach `device-id:`, whose localStorage copy must stay put — a shard
 * key embeds it, so an async miss would fork the shard.
 */
const shardStore = new KvPrefixCache<unknown>({ prefix: "favorite-gifs-shard:" });
const mergedStore = new KvPrefixCache<unknown>({ prefix: "favorite-gifs-merged:" });

/**
 * Load both stores, then drop the derived memos below and re-render: they may
 * hold results computed while the stores still read empty.
 */
function warmFavoriteGifStores(): Promise<void> {
  return Promise.all([shardStore.ready(), mergedStore.ready()]).then(() => {
    mergedCache.clear();
    ownShardCache.clear();
    notify();
  });
}

/** Whether both stores have loaded, i.e. whether a miss means "nothing". */
function storesWarm(): boolean {
  return shardStore.warmed && mergedStore.warmed;
}

export interface FavoriteGifRecord {
  gif: GifResult;
  favorite: boolean;
  /** Lamport-style millisecond clock. Highest operation wins for this GIF. */
  updatedAt: number;
  /** Deterministic tie-breaker for two devices updating in the same millisecond. */
  operationId: string;
}

/**
 * One encrypted NIP-78 document per Armada installation. Devices only rewrite
 * their own shard, so an offline device can never replace another device's
 * legacy favorites before the two sets have been merged.
 */
export interface FavoriteGifShard {
  version: 1;
  deviceId: string;
  records: FavoriteGifRecord[];
}

const mergedCache = new Map<string, FavoriteGifRecord[]>();
const ownShardCache = new Map<string, FavoriteGifShard>();
const snapshotCache = new Map<string, FavoriteGifRecord[]>();
const listeners = new Set<() => void>();
const dirtyListeners = new Set<(pubkey: string) => void>();
const EMPTY: FavoriteGifRecord[] = [];

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function favoriteGifsDeviceId(pubkey: string): string {
  try {
    const key = `${DEVICE_ID_PREFIX}${pubkey}`;
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = randomId();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return randomId();
  }
}

function isGifResult(value: unknown): value is GifResult {
  if (!value || typeof value !== "object") return false;
  const gif = value as Partial<GifResult>;
  return typeof gif.id === "string"
    && typeof gif.title === "string"
    && typeof gif.url === "string"
    && typeof gif.width === "number"
    && typeof gif.height === "number";
}

function isRecord(value: unknown): value is FavoriteGifRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<FavoriteGifRecord>;
  return isGifResult(record.gif)
    && typeof record.favorite === "boolean"
    && typeof record.updatedAt === "number"
    && Number.isFinite(record.updatedAt)
    && typeof record.operationId === "string";
}

/** Validate decrypted network/local data before it reaches the favorites UI. */
export function parseFavoriteGifShard(value: unknown): FavoriteGifShard | null {
  if (!value || typeof value !== "object") return null;
  const shard = value as Partial<FavoriteGifShard>;
  if (shard.version !== 1 || typeof shard.deviceId !== "string" || !Array.isArray(shard.records)) {
    return null;
  }
  return {
    version: 1,
    deviceId: shard.deviceId,
    records: shard.records.filter(isRecord),
  };
}

function parseLegacyFavorites(): GifResult[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LEGACY_FAVORITE_GIFS_KEY) ?? "");
    return Array.isArray(parsed) ? parsed.filter(isGifResult) : [];
  } catch {
    return [];
  }
}

function recordWins(candidate: FavoriteGifRecord, current: FavoriteGifRecord | undefined): boolean {
  return !current
    || candidate.updatedAt > current.updatedAt
    || (candidate.updatedAt === current.updatedAt && candidate.operationId > current.operationId);
}

function mergeRecords(...sets: readonly FavoriteGifRecord[][]): FavoriteGifRecord[] {
  const merged = new Map<string, FavoriteGifRecord>();
  for (const records of sets) {
    for (const record of records) {
      if (!isRecord(record)) continue;
      const current = merged.get(record.gif.id);
      if (recordWins(record, current)) merged.set(record.gif.id, record);
    }
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.operationId.localeCompare(a.operationId));
}

function ownShardId(pubkey: string): string {
  return `${pubkey}:${favoriteGifsDeviceId(pubkey)}`;
}

function loadMerged(pubkey: string): FavoriteGifRecord[] {
  const hit = mergedCache.get(pubkey);
  if (hit) return hit;
  void warmFavoriteGifStores();
  let records: FavoriteGifRecord[] = [];
  const parsed = mergedStore.get(pubkey);
  if (Array.isArray(parsed)) records = mergeRecords(parsed.filter(isRecord));
  records = mergeRecords(records, loadOwnFavoriteGifShard(pubkey).records);
  // Only memoise a result the stores could actually answer. Caching an empty
  // read taken before they loaded would outlive the load.
  if (storesWarm()) mergedCache.set(pubkey, records);
  return records;
}

/**
 * Persist the union. MERGES with what is already stored rather than replacing
 * it: a toggle taken before the stores loaded computed its `records` from an
 * empty read, and a straight replace would drop every favorite still on disk.
 * Merging is free of that hazard by construction — the CRDT keeps the highest
 * `updatedAt` per GIF, so no stale record can win and no tombstone is lost.
 */
function saveMerged(pubkey: string, records: FavoriteGifRecord[]): void {
  const stored = mergedStore.get(pubkey);
  const next = mergeRecords(records, Array.isArray(stored) ? stored.filter(isRecord) : []);
  mergedCache.set(pubkey, next);
  mergedStore.set(pubkey, next);
}

function notify(): void {
  snapshotCache.clear();
  for (const listener of listeners) listener();
}

export function loadOwnFavoriteGifShard(pubkey: string): FavoriteGifShard {
  const hit = ownShardCache.get(pubkey);
  if (hit) return hit;
  void warmFavoriteGifStores();
  const empty: FavoriteGifShard = { version: 1, deviceId: favoriteGifsDeviceId(pubkey), records: [] };
  const parsed = parseFavoriteGifShard(shardStore.get(ownShardId(pubkey)));
  const shard = parsed?.deviceId === empty.deviceId ? parsed : empty;
  // As in `loadMerged`: an empty read taken before the stores loaded is not an
  // answer worth remembering.
  if (storesWarm()) ownShardCache.set(pubkey, shard);
  return shard;
}

/** Persist this device's shard, merging with what is stored — see `saveMerged`. */
function saveOwnShard(pubkey: string, shard: FavoriteGifShard): void {
  const stored = parseFavoriteGifShard(shardStore.get(ownShardId(pubkey)));
  const next: FavoriteGifShard = {
    ...shard,
    records: mergeRecords(shard.records, stored?.deviceId === shard.deviceId ? stored.records : []),
  };
  ownShardCache.set(pubkey, next);
  shardStore.set(ownShardId(pubkey), next);
}

/** Fold decrypted shards into the durable local union. Tombstones are retained. */
export function hydrateFavoriteGifShards(pubkey: string, shards: FavoriteGifShard[]): void {
  const previous = loadMerged(pubkey);
  const own = loadOwnFavoriteGifShard(pubkey);
  const remoteOwnRecords = shards
    .filter((shard) => shard.deviceId === own.deviceId)
    .flatMap((shard) => shard.records);
  const ownRecords = mergeRecords(own.records, remoteOwnRecords);
  if (JSON.stringify(ownRecords) !== JSON.stringify(own.records)) {
    saveOwnShard(pubkey, { ...own, records: ownRecords });
  }
  const next = mergeRecords(previous, ownRecords, ...shards.map((s) => s.records));
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  saveMerged(pubkey, next);
  notify();
}

/**
 * Copy the pre-sync device-wide list into this installation's private shard.
 * Existing remote operations (including unfavorite tombstones) take priority;
 * legacy entries only fill GIF ids for which no synced decision exists yet.
 */
export function claimLegacyFavoriteGifs(pubkey: string): { hadLegacy: boolean; changed: boolean } {
  const legacy = parseLegacyFavorites();
  if (legacy.length === 0) return { hadLegacy: false, changed: false };

  const known = new Map(loadMerged(pubkey).map((record) => [record.gif.id, record]));
  const own = loadOwnFavoriteGifShard(pubkey);
  const ownById = new Map(own.records.map((record) => [record.gif.id, record]));
  let changed = false;

  // The old array is oldest-first. Preserve that ordering in the migration.
  for (const [index, gif] of legacy.entries()) {
    if (known.has(gif.id)) continue;
    const record: FavoriteGifRecord = {
      gif,
      favorite: true,
      // Legacy imports are baseline facts, not actions happening right now.
      // Keeping their clocks low means a phone migrating late cannot outvote
      // an unfavorite performed in a sync-aware client while it was offline.
      updatedAt: index + 1,
      operationId: randomId(),
    };
    known.set(gif.id, record);
    ownById.set(gif.id, record);
    changed = true;
  }

  if (changed) {
    const shard = { ...own, records: [...ownById.values()] };
    saveOwnShard(pubkey, shard);
    saveMerged(pubkey, [...known.values()]);
    notify();
  }
  return { hadLegacy: true, changed };
}

/** Remove the old device-wide copy only after its encrypted shard was signed and queued. */
export function completeLegacyFavoriteGifMigration(): void {
  try {
    localStorage.removeItem(LEGACY_FAVORITE_GIFS_KEY);
  } catch {
    // A later run will harmlessly retry the same merge.
  }
}

export function getFavoriteGifShardDTag(pubkey: string): string {
  return `${FAVORITE_GIFS_D_PREFIX}${favoriteGifsDeviceId(pubkey)}`;
}

export function subscribeFavoriteGifChanges(listener: (pubkey: string) => void): () => void {
  dirtyListeners.add(listener);
  return () => dirtyListeners.delete(listener);
}

/** Current winning records, including unfavorite tombstones. */
export function getFavoriteGifRecords(pubkey: string): FavoriteGifRecord[] {
  return loadMerged(pubkey);
}

/** Optimistically apply an explicit favorite/unfavorite action on this device. */
export function toggleFavoriteGif(pubkey: string, gif: GifResult): void {
  const merged = loadMerged(pubkey);
  const current = merged.find((record) => record.gif.id === gif.id);
  const legacyFavorite = !current && parseLegacyFavorites().some((entry) => entry.id === gif.id);
  const own = loadOwnFavoriteGifShard(pubkey);
  const ownById = new Map(own.records.map((record) => [record.gif.id, record]));
  const updatedAt = Math.max(Date.now(), ...merged.map((record) => record.updatedAt + 1));
  const record: FavoriteGifRecord = {
    gif,
    favorite: !(current?.favorite ?? legacyFavorite),
    updatedAt,
    operationId: randomId(),
  };
  ownById.set(gif.id, record);
  saveOwnShard(pubkey, { ...own, records: [...ownById.values()] });
  saveMerged(pubkey, mergeRecords(merged, [record]));
  notify();
  for (const listener of dirtyListeners) listener(pubkey);
}

function toggleLegacyFavorite(gif: GifResult): void {
  const previous = parseLegacyFavorites();
  const existing = previous.findIndex((entry) => entry.id === gif.id);
  const next = [...previous];
  if (existing >= 0) next.splice(existing, 1);
  else next.push(gif);
  try {
    localStorage.setItem(LEGACY_FAVORITE_GIFS_KEY, JSON.stringify(next));
  } catch {
    // localStorage may be full or unavailable.
  }
  notify();
}

function snapshot(pubkey: string | undefined): FavoriteGifRecord[] {
  const cacheKey = pubkey ?? "__legacy__";
  const hit = snapshotCache.get(cacheKey);
  if (hit) return hit;
  if (!pubkey) {
    const legacy = parseLegacyFavorites().map((gif, index) => ({
      gif,
      favorite: true,
      updatedAt: index,
      operationId: gif.id,
    })).reverse();
    snapshotCache.set(cacheKey, legacy);
    return legacy;
  }
  const synced = loadMerged(pubkey);
  const known = new Set(synced.map((record) => record.gif.id));
  const legacyOnly = parseLegacyFavorites()
    .filter((gif) => !known.has(gif.id))
    .map((gif, index) => ({ gif, favorite: true, updatedAt: index, operationId: gif.id }));
  const result = mergeRecords(synced, legacyOnly);
  snapshotCache.set(cacheKey, result);
  return result;
}

function subscribe(pubkey: string | undefined, listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === LEGACY_FAVORITE_GIFS_KEY || (pubkey && event.key.includes(pubkey))) {
      if (pubkey) {
        mergedCache.delete(pubkey);
        ownShardCache.delete(pubkey);
      }
      snapshotCache.clear();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Account-scoped GIF favorites, optimistically local and relay-synced in NostrSync. */
export function useFavoriteGifs() {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const records = useSyncExternalStore(
    (listener) => subscribe(pubkey, listener),
    () => snapshot(pubkey),
    () => EMPTY,
  );
  const favorites = records.filter((record) => record.favorite);

  const isFavorite = useCallback(
    (id: string) => favorites.some((record) => record.gif.id === id),
    [favorites],
  );

  const toggleFavorite = useCallback((gif: GifResult) => {
    if (pubkey) toggleFavoriteGif(pubkey, gif);
    else toggleLegacyFavorite(gif);
  }, [pubkey]);

  const favoriteList = useCallback(
    () => favorites.map((record) => record.gif),
    [favorites],
  );

  return { isFavorite, toggleFavorite, favoriteList, count: favorites.length };
}

/** Test seam for independent localStorage scenarios. */
export async function resetFavoriteGifsCache(): Promise<void> {
  mergedCache.clear();
  ownShardCache.clear();
  snapshotCache.clear();
  // The shards outlive `localStorage.clear()` now — they are in KV.
  await Promise.all([shardStore.clear(), mergedStore.clear()]);
}
