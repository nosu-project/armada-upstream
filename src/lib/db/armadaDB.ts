/**
 * The app-wide {@link ArmadaDB} instance.
 *
 * The IndexedDB adapter is used unconditionally for now. The SQLite adapter
 * exists and passes the same conformance suite, but selecting it needs a
 * driver for each transport (SQLite-WASM worker, the Capacitor bridge) that
 * can run interleaved statements on one connection — see `db/driver.ts`.
 *
 * Kept as a lazy singleton rather than being built in the provider so that
 * non-React code (sync loops, the wire bus, the logout purge) reaches the same
 * connections, and so React StrictMode's double-render can't open two.
 */
import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";

import type { ArmadaDB } from "./types";

/** Prefix for the IndexedDB databases the app-wide instance owns. */
export const ARMADA_DB_NAME = "armada";

/**
 * Tenants whose id is a fixed string, named here so the logout purge can
 * delete their databases on Firefox — which has no `indexedDB.databases()` to
 * enumerate with, and so cannot discover a tenant it was never told about.
 *
 * Tenants with a DYNAMIC id (per community, per account) can't be listed and
 * are therefore purged only where enumeration exists. Migrating such a store
 * needs a durable tenant registry first.
 */
export const ARMADA_TENANTS = {
  /** Concord V2 wraps parked by the native service for WebView decryption. */
  c2Park: "c2park",
} as const;

let instance: IndexedDBArmadaDB | undefined;

/** The app-wide database, opened on first use. */
export function getArmadaDB(): ArmadaDB {
  instance ??= new IndexedDBArmadaDB(ARMADA_DB_NAME);
  return instance;
}

/**
 * Close and delete every database the app-wide instance owns (logout purge).
 *
 * Tenant database names are dynamic (`armada:t:<id>`), so the general purge
 * can only find them where `indexedDB.databases()` exists — Firefox has no
 * such call, and gets {@link ARMADA_TENANTS} instead. Deleting them here also
 * means the connections are CLOSED first: `deleteDatabase` against an open
 * connection is blocked, not applied.
 */
export async function purgeArmadaDB(): Promise<void> {
  await instance?.close().catch(() => undefined);
  instance = undefined;

  if (typeof indexedDB === "undefined") return;

  const names = new Set<string>([
    `${ARMADA_DB_NAME}:kv`,
    ...Object.values(ARMADA_TENANTS).map((id) =>
      IndexedDBArmadaDB.databaseName(ARMADA_DB_NAME, id)
    ),
  ]);

  try {
    if (typeof indexedDB.databases === "function") {
      for (const { name } of await indexedDB.databases()) {
        if (name?.startsWith(`${ARMADA_DB_NAME}:`)) names.add(name);
      }
    }
  } catch {
    // best-effort — fall through with just the KV database
  }

  await Promise.all(
    [...names].map((name) =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      })
    ),
  );
}
