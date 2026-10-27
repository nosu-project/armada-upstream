/**
 * The state the page and `src/sw/worker.ts` share about push: the sealed
 * config, the kill switch, and the worker's ledgers (`own/`, `seen/`,
 * `alert/`, `badge`). IndexedDB, not Cache Storage: the Cache API keys only
 * http(s) URLs, which an nsite's origin is not, and Tenna's iOS notification
 * extension gets a cache of its own but shares IndexedDB (tenna/NAPP.md).
 */

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "armada-push-state";
const STORE = "state";
/** Set in the same transaction as the one-time copy out of the legacy cache. */
const MIGRATED_KEY = "#migrated";
const LEGACY_CACHE = "armada-push-state-v1";
const LEGACY_PREFIX = "/.armada-push-state/";

export const PUSH_STATE_DB_NAME = DB_NAME;

/** `at`/`n` order entries by when they were last written, for {@link trimPushState}. */
interface Entry {
  value: unknown;
  at: number;
  n: number;
}

let counter = 0;
const entry = (value: unknown): Entry => ({ value, at: Date.now(), n: ++counter });

let opened: { factory: IDBFactory; db: Promise<IDBPDatabase> } | undefined;

function database(): Promise<IDBPDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error("IndexedDB unavailable"));
  if (opened?.factory !== factory) {
    const db = openDB(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore(STORE);
      },
      // Let logout's deleteDatabase through; the next call reopens.
      blocking() {
        void db.then((d) => d.close());
        if (opened?.db === db) opened = undefined;
      },
      terminated() {
        if (opened?.db === db) opened = undefined;
      },
    }).then(async (d) => {
      await migrateLegacyCache(d);
      return d;
    });
    db.catch(() => {
      if (opened?.db === db) opened = undefined;
    });
    opened = { factory, db };
  }
  return opened.db;
}

/** A legacy Cache Storage value in the shape its key now stores. */
async function legacyValue(key: string, response: Response): Promise<unknown> {
  if (key === "dm-config") return new Uint8Array(await response.arrayBuffer());
  if (key === "badge") return Number.parseInt(await response.text(), 10) || 0;
  if (key === "disabled" || key.startsWith("own/")) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    // Unreadable: dropped.
  }
  // The oldest seen/ entries held the literal "1".
  if (key.startsWith("seen/")) return parsed && typeof parsed === "object" ? parsed : { outcome: "handled" };
  return parsed;
}

/**
 * Copy what an older build kept in Cache Storage, once per install. Nothing
 * already written here is overwritten, so a newer page's write survives an
 * older context migrating after it.
 */
async function migrateLegacyCache(db: IDBPDatabase): Promise<void> {
  if (await db.get(STORE, MIGRATED_KEY)) return;
  const found: [string, unknown][] = [];
  if (typeof caches !== "undefined") {
    try {
      if (await caches.has(LEGACY_CACHE)) {
        const cache = await caches.open(LEGACY_CACHE);
        for (const request of await cache.keys()) {
          const path = new URL(request.url).pathname;
          if (!path.startsWith(LEGACY_PREFIX)) continue;
          const key = path.slice(LEGACY_PREFIX.length);
          const response = await cache.match(request);
          if (!response) continue;
          const value = await legacyValue(key, response);
          if (value !== undefined) found.push([key, value]);
        }
      }
    } catch {
      // Retried on the next open: the marker is not set.
      return;
    }
  }
  const tx = db.transaction(STORE, "readwrite");
  if (!(await tx.store.get(MIGRATED_KEY))) {
    for (const [key, value] of found) {
      if ((await tx.store.getKey(key)) === undefined) await tx.store.put(entry(value), key);
    }
    await tx.store.put(entry(true), MIGRATED_KEY);
  }
  await tx.done;
  try {
    if (typeof caches !== "undefined") await caches.delete(LEGACY_CACHE);
  } catch {
    // Copied and marked already; a leftover cache is never read again.
  }
}

export async function readPushState<T = unknown>(key: string): Promise<T | undefined> {
  const stored = (await (await database()).get(STORE, key)) as Entry | undefined;
  return stored?.value as T | undefined;
}

/** Write `value`, which also makes `key` the newest entry for {@link trimPushState}. */
export async function writePushState(key: string, value: unknown): Promise<void> {
  await (await database()).put(STORE, entry(value), key);
}

export async function deletePushState(key: string): Promise<void> {
  await (await database()).delete(STORE, key);
}

/** The keys under `prefix`, oldest-written first. */
export async function pushStateKeys(prefix: string): Promise<string[]> {
  const db = await database();
  const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  const tx = db.transaction(STORE, "readonly");
  const [keys, entries] = await Promise.all([
    tx.store.getAllKeys(range),
    tx.store.getAll(range) as Promise<Entry[]>,
  ]);
  await tx.done;
  return keys
    .map((key, i) => ({ key: String(key), at: entries[i]?.at ?? 0, n: entries[i]?.n ?? 0 }))
    .sort((a, b) => a.at - b.at || a.n - b.n)
    .map(({ key }) => key);
}

/** Drop the oldest-written entries under `prefix` past `max`. */
export async function trimPushState(prefix: string, max: number): Promise<void> {
  const keys = await pushStateKeys(prefix);
  if (keys.length <= max) return;
  const db = await database();
  const tx = db.transaction(STORE, "readwrite");
  await Promise.all(keys.slice(0, keys.length - max).map((key) => tx.store.delete(key)));
  await tx.done;
}
