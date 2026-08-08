/**
 * The app-wide {@link ArmadaDB} instance, and which adapter backs it.
 *
 *  - **Android** uses the native store: one SQLite file, with the query engine
 *    in Kotlin (`buzz.armada.app.db`), shared with the background notification
 *    service. That sharing is why it exists — the service writes an event into
 *    the tenant the app reads it from, so a message received while the app was
 *    dead is simply there on open, rather than being replayed out of a private
 *    database the service kept to itself.
 *  - **iOS** uses the same native store, with the query engine in Swift
 *    (`ios/ArmadaDB`) and its file in the App Group container — the one place
 *    an extension can also read, which is what a notification extension will
 *    need for the same reason Android's service does.
 *  - **Desktop (Electron)** is arranged the same way, for the same reason one
 *    layer down: the engine is `SqliteArmadaDB` in the shell's main process,
 *    over one file in the OS's per-app config directory. That puts a desktop
 *    user's messages somewhere they can find, back up and move between
 *    machines, rather than inside a Chromium profile keyed by the renderer's
 *    origin — and it runs the engine the conformance suite actually exercises.
 *  - **Everywhere else** uses IndexedDB. The SQLite adapter would serve a
 *    SQLite-WASM worker too, but no driver for one exists yet.
 *
 * The choice is made once, before anything reads, and never revisited: an
 * Android or iOS install never opens the IndexedDB adapter, so there is never a
 * second store to reconcile against.
 *
 * Kept as a lazy singleton rather than being built in the provider so that
 * non-React code (sync loops, the wire bus, the logout purge) reaches the same
 * connections, and so React StrictMode's double-render can't open two.
 */
import { createElectronArmadaDB, hasElectronArmadaDB } from "./ElectronArmadaDB";
import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";
import { hasNativeArmadaDB, NativeArmadaDB } from "./NativeArmadaDB";

import type { ArmadaDB } from "./types";

/** Prefix for the IndexedDB databases the app-wide instance owns. */
export const ARMADA_DB_NAME = "armada";

/**
 * Tenants whose id is a fixed string, so call sites share one spelling.
 *
 * The purge doesn't depend on this list — it reads the adapter's durable
 * tenant registry, which covers dynamic ids too — but naming them costs
 * nothing and keeps them deletable if the registry itself is unreadable.
 */
export const ARMADA_TENANTS = {
  /**
   * The general event cache: events whose meaning doesn't depend on who served
   * them (profiles, the user's own lists, git activity, sealed Concord outers).
   * See `mainEventStore.ts`.
   *
   * NIP-29 is deliberately NOT here: a group id means nothing without its relay,
   * so it lives in one tenant per relay (`nip29:<url>`, see `relayScope.ts`).
   */
  main: "main",
  /** Concord V2 wraps parked by the native service for WebView decryption. */
  c2Park: "c2park",
  /**
   * The native service's handoff queue: events it ingested, awaiting a pass
   * through wire ingest. Written only by the Android service, drained and
   * emptied by `WireSync`. Mirrors `ArmadaDb.TENANT_SERVICE_QUEUE` in Kotlin.
   */
  serviceQueue: "svc",
} as const;

let instance: IndexedDBArmadaDB | NativeArmadaDB | undefined;

/**
 * The app-wide database, opened on first use.
 *
 * Both native branches produce a {@link NativeArmadaDB} — the same store over a
 * different transport — so everything downstream, the purge below included,
 * only ever has two cases to think about.
 */
export function getArmadaDB(): ArmadaDB {
  if (!instance) {
    if (hasNativeArmadaDB()) instance = new NativeArmadaDB();
    else if (hasElectronArmadaDB()) instance = createElectronArmadaDB();
    else instance = new IndexedDBArmadaDB(ARMADA_DB_NAME);
  }
  return instance;
}

/**
 * Close and delete every database the app-wide instance owns (logout purge).
 *
 * Tenant database names are dynamic (`armada:t:<id>`), and Firefox has no
 * `indexedDB.databases()` to enumerate them with — so the adapter keeps a
 * durable registry of every tenant it has opened, and that is what this
 * deletes. Enumeration, where it exists, is a second pass on top. Deleting
 * here also means the connections are CLOSED first: `deleteDatabase` against
 * an open connection is blocked, not applied.
 */
export async function purgeArmadaDB(): Promise<void> {
  // The native store is one file on one connection — shared, on Android, with
  // a background service that goes on writing to it — so it is EMPTIED rather
  // than deleted and the connection stays open. Nothing else to sweep: an
  // Android, iOS or desktop install never opens the IndexedDB adapter, so there
  // are no databases to delete.
  if (instance instanceof NativeArmadaDB) {
    await instance.wipe().catch(() => undefined);
    return;
  }

  if (typeof indexedDB === "undefined") {
    instance = undefined;
    return;
  }

  // Opened if it wasn't already: the registry is on disk, so a logout in a
  // session that never touched the database still has tenants to delete.
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
    // best-effort — the registry above is the primary source
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
