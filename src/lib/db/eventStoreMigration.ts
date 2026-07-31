/**
 * Drain of the pre-ArmadaDB event cache into the `main` tenant.
 *
 * The old store had three backends (native Android SQLite, SQLite-WASM over
 * OPFS, and `NIndexedDB` as a degraded fallback) behind one interface. Only the
 * IndexedDB one is drained here: it is the only backend reachable from this
 * layer without resurrecting the SQL stack that was just deleted, and the
 * SQLite backends held nothing that isn't refetchable from relays.
 *
 * Unlike the DM, invite and Concord drains, this one is not protecting
 * irreplaceable data — a cached relay event can be fetched again. It exists so
 * an upgrading user's profiles and timelines paint immediately instead of after
 * a cold refetch, and so the abandoned database is actually deleted.
 *
 * Signatures are not carried across: ArmadaDB stores rumors, and nothing reads
 * a cached event's `sig` (see `mainEventStore.ts`).
 */
import { NIndexedDB } from "@nostrify/indexeddb";

import { ARMADA_TENANTS, getArmadaDB } from "./armadaDB";
import { skipLegacyDrain } from "./legacyDatabases";

/** The retired IndexedDB event cache. */
export const LEGACY_EVENT_DB_NAME = "armada-events";

/** The OPFS directory the retired SQLite-WASM backend claimed. */
const LEGACY_OPFS_DIRECTORY = ".armada-sqlite";

const DONE_KEY = "events:migrated";

/** Rows per page of the newest-first scan. Exported so tests can span pages. */
export const PAGE_LIMIT = 500;

/** Runaway guard: a cache this deep is already past anything worth copying. */
const MAX_PAGES = 200;

let drain: Promise<void> | undefined;

/**
 * Copy the legacy event cache into the `main` tenant. Runs at most once.
 *
 * REJECTS when the copy fails. Nothing here is irreplaceable, but the startup
 * gate reads a resolved drain as "safe to delete the source", and that same
 * round deletes databases that ARE irreplaceable — so this reports failure
 * like every other drain rather than quietly costing the user a cold refetch.
 */
export function migrateLegacyEvents(): Promise<void> {
  drain ??= drainLegacyEvents().catch((err: unknown) => {
    drain = undefined;
    throw err;
  });
  return drain;
}

async function drainLegacyEvents(): Promise<void> {
  const db = getArmadaDB();
  if (await db.kv.get<boolean>(DONE_KEY)) return;
  if (typeof indexedDB === "undefined") return;
  // `NIndexedDB` CREATES the database on its first query; see `skipLegacyDrain`.
  if (await skipLegacyDrain(LEGACY_EVENT_DB_NAME)) {
    // Still sweep OPFS. A user who ran the SQLite-WASM backend has no
    // `armada-events` database at all, so this is the only path that reaches
    // them — and the directory is tens of megabytes nothing will ever read.
    await removeLegacyOpfs();
    await db.kv.set(DONE_KEY, true);
    return;
  }

  const legacy = new NIndexedDB(LEGACY_EVENT_DB_NAME);
  const tenant = db.tenant(ARMADA_TENANTS.main);

  try {
    // Newest-first pages, walking `until` backwards. Ties on `created_at` mean
    // a page can overlap the previous one, so progress is measured in NEW ids
    // and the walk ends when a page contributes none.
    const seen = new Set<string>();
    let until: number | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await legacy.query([
        until === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, until },
      ]);
      const fresh = rows.filter((ev) => !seen.has(ev.id));
      if (fresh.length === 0) break;

      // One batch per page rather than an await per event: the adapter
      // coalesces concurrent writes into a single transaction, and a deep cache
      // is tens of thousands of rows.
      await Promise.all(
        fresh.map((event) => {
          seen.add(event.id);
          const { sig: _sig, ...rumor } = event;
          return tenant.event(rumor);
        }),
      );

      if (rows.length < PAGE_LIMIT) break;
      until = Math.min(...rows.map((ev) => ev.created_at));
    }
  } finally {
    await legacy.close().catch(() => undefined);
  }

  await removeLegacyOpfs();
  await db.kv.set(DONE_KEY, true);
}

/**
 * Drop the retired SQLite-WASM database's OPFS directory. Not drained — its
 * contents are refetchable — but leaving tens of megabytes of orphaned bytes
 * behind would be worse than deleting them.
 */
async function removeLegacyOpfs(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(LEGACY_OPFS_DIRECTORY, { recursive: true });
  } catch {
    // best-effort: absent on most platforms, or still held open
  }
}
