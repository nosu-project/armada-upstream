import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { ARMADA_DB_NAME, purgeArmadaDB } from "@/lib/db/armadaDB";
import { resetKvCaches } from "@/lib/db/kvCache";
import { LEGACY_DATABASE_NAMES } from "@/lib/db/legacyDatabases";
import { resetDecryptConsent } from "@/lib/decryptConsent";

/**
 * localStorage keys that must survive a purge. `armada:login` is the nostrify
 * login store: it's mutated by `removeLogin` in the same tick we purge, and
 * blowing it away here would race that update and resurrect a stale session.
 * We clear it (and everything else) only as the final account logs out.
 */
const PRESERVE_LOCAL_STORAGE_KEYS = new Set<string>(["armada:login"]);

/**
 * Remove the OPFS directory the retired SQLite-WASM event store used. Nothing
 * writes it any more (the event cache is an ArmadaDB tenant), but a user
 * upgrading across that change still has the bytes on disk, and a logout must
 * not leave them.
 */
async function purgeOrphanedOpfs(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(".armada-sqlite", { recursive: true });
  } catch {
    // best-effort — absent (the common case) or held open
  }
}

/** Best-effort deletion of every IndexedDB database this origin owns. */
async function purgeIndexedDB(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    // `indexedDB.databases()` is unsupported on Firefox; fall back to the
    // known Armada database names so we still wipe the bulk of the data.
    const known = [
      // ArmadaDB's KV database. Its tenant databases (`armada:t:<id>`) have
      // dynamic names, so `purgeArmadaDB` deletes those — it can enumerate
      // and, more importantly, close them first.
      `${ARMADA_DB_NAME}:kv`,
      // Every pre-ArmadaDB database: nothing reads them any more, but a purge
      // still has to remove whatever an older build left behind.
      ...LEGACY_DATABASE_NAMES,
    ];
    const dbs =
      typeof indexedDB.databases === "function"
        ? (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => Boolean(n))
        : known;
    await Promise.all(
      [...new Set([...dbs, ...known])].map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
    );
  } catch {
    // best-effort
  }
}

/** Best-effort deletion of every Cache Storage entry this origin owns. */
async function purgeCacheStorage(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // best-effort
  }
}

/** Wipe all Armada localStorage (everything except the preserved keys). */
function purgeLocalStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && !PRESERVE_LOCAL_STORAGE_KEYS.has(key)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {
    // best-effort
  }
}

/**
 * Purge all client-side persistence so a fresh logout leaves nothing behind:
 * the event cache, Concord caches, the persistent decrypt cache, decrypted
 * image bytes, per-user read-state and drafts, relay-info, voice/notification
 * prefs, theme, and the added-server list. The in-memory DM render memo is
 * dropped too.
 *
 * `armada:login` is intentionally left for the caller's `removeLogin` to manage
 * in the same tick; everything else (including `armada:app-config`) is wiped so
 * the next session starts truly clean.
 */
export async function purgeClientStorage(): Promise<void> {
  clearRenderedPlaintext();
  resetDecryptConsent();
  // The KV-backed caches (drafts, relay info, emoji palettes, GIF shards) keep
  // their own copy in memory. Deleting the database underneath them would
  // leave the next account reading the previous one's data straight out of it.
  resetKvCaches();
  purgeLocalStorage();
  // ArmadaDB first: `deleteDatabase` against an open connection is blocked,
  // not applied, so its databases have to be closed before the sweep runs.
  await purgeArmadaDB();
  await Promise.all([purgeIndexedDB(), purgeCacheStorage(), purgeOrphanedOpfs()]);
}
