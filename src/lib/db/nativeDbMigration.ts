/**
 * Drain of the IndexedDB ArmadaDB into the native one, on Android.
 *
 * Android used to run the same IndexedDB adapter as the web build. It now runs
 * the native store (`buzz.armada.app.db`), so that the background notification
 * service and the WebView share one database — but an install that upgrades into
 * that has its whole local state sitting in the adapter it just stopped using.
 *
 * What is in there is not refetchable. Decrypted Concord history and decrypted
 * NIP-17 messages exist nowhere else once the relays drop the wraps that carried
 * them; so do read state, folds and sync cursors. Switching adapters without
 * this drain would present the user with an empty app and silently strand all of
 * it, which is the failure mode Armada has already been bitten by twice.
 *
 * The KV is copied FIRST, and that ordering is load-bearing: every other drain's
 * completion flag lives in it, including `migrations:complete`. Copy it before
 * they run and they correctly see themselves as done; leave it and every legacy
 * drain re-runs against databases that were deleted long ago, recreating them
 * empty as it goes.
 *
 * Nothing is deleted until everything has been copied. A drain that throws
 * leaves the source intact for the next launch to retry, exactly as the legacy
 * catalogue's do.
 */
import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";
import {
  ARMADA_DB_NAME,
  ARMADA_TENANTS,
  closeIndexedDBArmadaDB,
  getArmadaDB,
  openIndexedDBArmadaDB,
} from "./armadaDB";
import { hasNativeArmadaDB } from "./NativeArmadaDB";

import type { ArmadaDB, NRumorStore } from "./types";

/** Set on the NATIVE side once the copy is done and the source is gone. */
const DONE_KEY = "nativedb:migrated";

/** Rumors per page of the newest-first scan. Exported so tests can span pages. */
export const PAGE_LIMIT = 500;

/**
 * Pages a single tenant's drain will walk. A tenant this deep is far past any
 * real history; hitting the bound means the paging is wrong, and the drain FAILS
 * rather than copying a prefix and letting the caller delete the rest.
 */
const MAX_PAGES = 2_000;

/** KV entries copied per batch, so a large store doesn't land as one burst. */
const KV_BATCH = 200;

/** Shown as a line in the startup gate's progress list. */
export const NATIVE_DB_MIGRATION_LABEL = "Moving the local database";

let drain: Promise<void> | undefined;

/**
 * Whether there is an IndexedDB ArmadaDB to move into the native store.
 *
 * Enumeration is the direct answer and the one that self-heals: a half-finished
 * run leaves databases behind and is found again next launch. Where enumeration
 * is unavailable the answer is "assume so" — the drain is idempotent, and its
 * own flag makes the second launch cheap.
 */
export async function nativeDbMigrationPending(): Promise<boolean> {
  if (!hasNativeArmadaDB()) return false;
  if (typeof indexedDB === "undefined") return false;

  try {
    if (await getArmadaDB().kv.get<boolean>(DONE_KEY)) return false;
  } catch {
    // fall through to enumeration
  }

  if (typeof indexedDB.databases === "function") {
    try {
      const names = (await indexedDB.databases()).flatMap((d) => (d.name ? [d.name] : []));
      return names.some((name) => name === `${ARMADA_DB_NAME}:kv` || name.startsWith(`${ARMADA_DB_NAME}:t:`));
    } catch {
      // fall through to assuming the worst
    }
  }

  return true;
}

/**
 * Copy the IndexedDB ArmadaDB into the native one and delete it. Runs at most
 * once per session, and REJECTS on failure — the caller reads a resolved drain
 * as "the source is gone", and the source holds the only copy of decrypted
 * message history.
 */
export function migrateToNativeDb(): Promise<void> {
  drain ??= runNativeDbMigration().catch((error: unknown) => {
    drain = undefined;
    throw error;
  });
  return drain;
}

async function runNativeDbMigration(): Promise<void> {
  if (!hasNativeArmadaDB()) return;

  const target = getArmadaDB();
  if (await target.kv.get<boolean>(DONE_KEY)) return;
  if (typeof indexedDB === "undefined") return;

  const source = openIndexedDBArmadaDB();

  try {
    await copyKv(source, target);

    const tenantIds = new Set([...await source.tenantIds(), ...Object.values(ARMADA_TENANTS)]);
    for (const id of tenantIds) {
      await copyTenant(source.tenant(id), target.tenant(id));
    }
  } finally {
    // Closed before anything is deleted: `deleteDatabase` against an open
    // connection is blocked, not applied.
    await closeIndexedDBArmadaDB();
  }

  // Only now, with everything copied and readable from the native store.
  await target.kv.set(DONE_KEY, true);
  await deleteIndexedDBArmadaDB();
}

/**
 * Copy every KV entry that the native store doesn't already hold.
 *
 * Existing keys are left alone rather than overwritten: on a retry after a
 * partial run the app has been reading and writing the native store in the
 * meantime, and the copy would put a stale value back over a fresh one.
 */
async function copyKv(source: ArmadaDB, target: ArmadaDB): Promise<void> {
  const keys = await source.kv.keys();

  for (let i = 0; i < keys.length; i += KV_BATCH) {
    await Promise.all(
      keys.slice(i, i + KV_BATCH).map(async (key) => {
        if (await target.kv.get(key) !== undefined) return;
        const value = await source.kv.get(key);
        if (value === undefined) return;
        await target.kv.set(key, value);
      }),
    );
  }
}

/**
 * Copy one tenant's rumors, newest-first.
 *
 * Ties on `created_at` mean a page can overlap the previous one, so progress is
 * measured in NEW ids and the walk ends when a page contributes none.
 */
async function copyTenant(source: NRumorStore, target: NRumorStore): Promise<void> {
  const seen = new Set<string>();
  let until: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rumors = await source.query([
      until === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, until },
    ]);

    const fresh = rumors.filter((rumor) => !seen.has(rumor.id));
    if (fresh.length === 0) return;

    // One batch per page rather than an await per rumor: both adapters coalesce
    // concurrent writes into a single transaction, and the bridge charges per
    // crossing.
    await Promise.all(
      fresh.map((rumor) => {
        seen.add(rumor.id);
        return target.event(rumor);
      }),
    );

    if (rumors.length < PAGE_LIMIT) return;
    until = Math.min(...rumors.map((rumor) => rumor.created_at));
  }

  throw new Error("ArmadaDB: native migration exceeded its page budget");
}

/**
 * Delete the IndexedDB databases the adapter owned. Best-effort, and only ever
 * called once the copy has been confirmed.
 */
async function deleteIndexedDBArmadaDB(): Promise<void> {
  const names = new Set<string>([`${ARMADA_DB_NAME}:kv`]);

  try {
    if (typeof indexedDB.databases === "function") {
      for (const { name } of await indexedDB.databases()) {
        if (name?.startsWith(`${ARMADA_DB_NAME}:`)) names.add(name);
      }
    }
  } catch {
    // best-effort — the tenant sweep below covers the common case
  }

  for (const id of Object.values(ARMADA_TENANTS)) {
    names.add(IndexedDBArmadaDB.databaseName(ARMADA_DB_NAME, id));
  }

  await Promise.all(
    [...names].map((name) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        // `onblocked` fires when a connection is still open; the database is
        // then deleted whenever it closes, so resolving is honest either way.
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      })
    ),
  );
}
