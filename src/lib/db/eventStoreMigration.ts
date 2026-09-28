/**
 * Drain of the pre-ArmadaDB IndexedDB event cache into the `main` tenant, so
 * upgraders paint immediately and the old DB is deleted. Only the IndexedDB
 * backend is drained; the old SQLite backends held only refetchable data.
 * Signatures aren't carried (ArmadaDB stores rumors).
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
 * Copy the legacy event cache into `main`, at most once. REJECTS on failure:
 * the startup gate reads a resolved drain as "safe to delete", in a round that
 * also deletes irreplaceable databases.
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
    // Still sweep OPFS: SQLite-WASM users have no `armada-events` DB at all.
    await removeLegacyOpfs();
    await db.kv.set(DONE_KEY, true);
    return;
  }

  const legacy = new NIndexedDB(LEGACY_EVENT_DB_NAME);
  const tenant = db.tenant(ARMADA_TENANTS.main);

  try {
    // Newest-first pages; `created_at` ties overlap pages, so stop when a page adds no new ids.
    const seen = new Set<string>();
    let until: number | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await legacy.query([
        until === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, until },
      ]);
      const fresh = rows.filter((ev) => !seen.has(ev.id));
      if (fresh.length === 0) break;

      // One batch per page: the adapter coalesces concurrent writes into one transaction.
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

/** Delete the retired SQLite-WASM OPFS directory (refetchable; tens of MB orphaned). */
async function removeLegacyOpfs(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(LEGACY_OPFS_DIRECTORY, { recursive: true });
  } catch {
    // best-effort: absent on most platforms, or still held open
  }
}
