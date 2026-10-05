/**
 * The app-wide {@link ArmadaDB} instance, chosen once before anything reads:
 *  - Android: native SQLite store (Kotlin engine), shared with the background
 *    notification service so events it receives are there on open.
 *  - iOS: same native store (Swift engine), in the App Group container so a
 *    notification extension can read it.
 *  - Desktop (Electron): `SqliteArmadaDB` in the main process, over a file in
 *    the per-app config dir (user-visible, portable).
 *  - Everywhere else: IndexedDB.
 * Lazy singleton so non-React code shares connections and StrictMode can't open two.
 */
import { createElectronArmadaDB, hasElectronArmadaDB } from "./ElectronArmadaDB";
import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";
import { hasNativeArmadaDB, NativeArmadaDB } from "./NativeArmadaDB";

import type { ArmadaDB } from "./types";

/** Prefix for the IndexedDB databases the app-wide instance owns. */
export const ARMADA_DB_NAME = "armada";

/** Fixed tenant ids (the purge reads the durable registry but also deletes these). */
export const ARMADA_TENANTS = {
  /**
   * General event cache for server-independent events (see `mainEventStore.ts`).
   * NIP-29 lives in per-relay tenants instead (`nip29:<url>`, see `relayScope.ts`).
   */
  main: "main",
  /** Concord wraps parked by the native service for WebView decryption. */
  c2Park: "c2park",
  /**
   * Native service handoff queue awaiting wire ingest; drained by `WireSync`.
   * Mirrors `ArmadaDb.TENANT_SERVICE_QUEUE` in Kotlin.
   */
  serviceQueue: "svc",
} as const;

let instance: IndexedDBArmadaDB | NativeArmadaDB | undefined;

/** The app-wide database, opened on first use. Both native branches are a {@link NativeArmadaDB}. */
export function getArmadaDB(): ArmadaDB {
  if (!instance) {
    if (hasNativeArmadaDB()) instance = new NativeArmadaDB();
    else if (hasElectronArmadaDB()) instance = createElectronArmadaDB();
    else instance = new IndexedDBArmadaDB(ARMADA_DB_NAME);
  }
  return instance;
}

/**
 * Fix the adapter to IndexedDB, for the Web Push service worker runtime
 * (`src/sw/pushRuntime.ts`), which shares the store with the page. Workers are
 * always the IndexedDB case (no push on Android/iOS/Electron).
 */
export function presetIndexedDBArmadaDB(): void {
  instance ??= new IndexedDBArmadaDB(ARMADA_DB_NAME);
}

/**
 * Close and delete every database the app-wide instance owns (logout purge).
 * Firefox lacks `indexedDB.databases()`, so the adapter's durable tenant
 * registry is primary. Connections must be closed first or deletes block.
 */
export async function purgeArmadaDB(): Promise<void> {
  // The native store is shared with a live background service: empty it, keep
  // the connection. Native installs never open IndexedDB.
  if (instance instanceof NativeArmadaDB) {
    await instance.wipe().catch(() => undefined);
    return;
  }

  if (typeof indexedDB === "undefined") {
    instance = undefined;
    return;
  }

  // The registry is on disk, so open even if this session never did.
  const db = (instance ??= new IndexedDBArmadaDB(ARMADA_DB_NAME));
  const tenantIds = await db.tenantIds().catch(() => [] as string[]);
  await db.close().catch(() => undefined);
  instance = undefined;

  const names = new Set<string>([
    `${ARMADA_DB_NAME}:kv`,
    ...[...tenantIds, ...Object.values(ARMADA_TENANTS)].map((id) =>
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
    // best-effort; the registry is the primary source
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
