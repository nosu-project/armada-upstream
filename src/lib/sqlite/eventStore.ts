import { Capacitor } from "@capacitor/core";
import { NIndexedDB } from "@nostrify/indexeddb";

import { probeNativeSqlDriver } from "./nativeDriver";
import { openWasmDriver } from "./wasmDriver";
import { SqliteEventStore } from "./SqliteEventStore";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";

/**
 * The app-wide event store, one per platform, one database each:
 *
 *  - **Android**: the native SQLite file shared with the notification
 *    service (via the Capacitor bridge) — kind-0 profiles and buffered
 *    events are stored ONCE, visible to both sides.
 *  - **Web / Electron**: the same schema on SQLite-WASM over OPFS.
 *  - **Degraded** (no Worker/OPFS — jsdom tests, exotic browsers, file://):
 *    the legacy NIndexedDB store, so nothing regresses below today's
 *    behavior.
 *
 * Module singleton (like rumorStore) so the logout purge can reach it.
 */
let storePromise: Promise<ArmadaEventStore> | undefined;

export function appEventStore(): Promise<ArmadaEventStore> {
  if (!storePromise) storePromise = open();
  return storePromise;
}

async function open(): Promise<ArmadaEventStore> {
  if (Capacitor.getPlatform() === "android") {
    const native = await probeNativeSqlDriver();
    if (native) return new SqliteEventStore(Promise.resolve(native), { src: "web" });
  }

  if (typeof Worker === "function") {
    try {
      const driver = await openWasmDriver();
      if (driver.vfs === "opfs-sahpool") {
        return new SqliteEventStore(Promise.resolve(driver), { src: "web" });
      }
      // Memory-only sqlite would lose the cache every session; the
      // persistent IndexedDB fallback below is strictly better.
      void driver.close().catch(() => undefined);
    } catch {
      // fall through
    }
  }

  return new NIndexedDB("armada-events");
}

/**
 * Logout purge: drop every event row (native/OPFS sqlite), and best-effort
 * remove the OPFS directory. The IndexedDB fallback's database is deleted by
 * purgeClientStorage's existing deleteDatabase pass.
 */
export async function purgeEventStore(): Promise<void> {
  try {
    if (storePromise) {
      const store = await storePromise;
      await store.wipe?.();
    }
  } catch {
    // best-effort
  }
  // A previous session may have left OPFS data even if this session fell
  // back elsewhere. Removal fails while the SAH pool holds handles — fine,
  // the wipe above already emptied the tables in that case.
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(".armada-sqlite", { recursive: true });
  } catch {
    // best-effort
  }
}
