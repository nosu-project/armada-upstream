/**
 * The {@link ArmadaDB} transport for the Electron desktop shell.
 *
 * Desktop is arranged like Android, not like the web: the query engine runs
 * outside the renderer, over one SQLite file in the OS's per-app config
 * directory (`app.getPath("userData")/armada.db`), and this is the bridge onto
 * it. See `electronMain.ts` for the process on the other end.
 *
 * There is no adapter class here, and that is the point. The bridge implements
 * `ArmadaDBPlugin` — the surface `ArmadaDbPlugin.kt` already exposes — so the
 * store is `NativeArmadaDB` with a different transport underneath. Every
 * behavior that layer owns comes with it unchanged: writes coalesced per tenant
 * onto one crossing per microtask, KV operations batched into a single ordered
 * `kvOps`, ids remembered so a relay cache's re-write costs nothing. A second
 * adapter would have had to re-earn all of it, and would have been free to
 * drift.
 *
 * Everything crosses as JSON text, as on Capacitor. Electron's IPC does use
 * structured clone, which would carry an integer `kind` faithfully — but a page
 * of rumors is still cheaper as one string than as a few thousand cloned
 * objects, and matching the wire format exactly is what lets the two platforms
 * share the adapter above.
 */
import { desktop } from "@/lib/desktop";

import { NativeArmadaDB } from "./NativeArmadaDB";

import type { ArmadaDBPlugin } from "./NativeArmadaDB";

/**
 * Whether the desktop shell is offering its SQLite store.
 *
 * False in a browser, and false in a shell older than the store — a newer web
 * bundle can always be loaded by an older shell, and the answer then has to be
 * IndexedDB rather than a broken bridge. Also false when the shell opened the
 * file and failed (a read-only profile directory, a corrupt database): the main
 * process reports that as unavailable up front, so a fallback is possible,
 * rather than letting every read reject later.
 */
export function hasElectronArmadaDB(): boolean {
  return Boolean(desktop()?.armadaDb?.available);
}

/**
 * The desktop store: `NativeArmadaDB` over the IPC bridge.
 *
 * @throws if the shell isn't offering one — call {@link hasElectronArmadaDB}
 * first.
 */
export function createElectronArmadaDB(): NativeArmadaDB {
  const bridge = desktop()?.armadaDb;
  if (!bridge?.available) throw new Error("The desktop shell has no ArmadaDB store");
  return new NativeArmadaDB(electronBridge(bridge.call));
}

/** `ArmadaDBPlugin`, dispatched over the shell's single `armada:db` channel. */
function electronBridge(call: (op: string, payload?: unknown) => Promise<unknown>): ArmadaDBPlugin {
  const send = <T>(op: string, payload?: unknown) => call(op, payload) as Promise<T>;

  return {
    query: (options) => send("query", options),
    event: (options) => send("event", options),
    count: (options) => send("count", options),
    remove: (options) => send("remove", options),
    tenants: () => send("tenants"),
    kvGet: (options) => send("kvGet", options),
    kvSet: (options) => send("kvSet", options),
    kvDelete: (options) => send("kvDelete", options),
    kvList: (options) => send("kvList", options),
    kvOps: (options) => send("kvOps", options),
    wipe: () => send("wipe"),
  };
}
