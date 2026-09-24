import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { clearRecentDecrypts } from "@/lib/AppSigner";
import { ARMADA_DB_NAME, purgeArmadaDB } from "@/lib/db/armadaDB";
import { resetKvCaches } from "@/lib/db/kvCache";
import { legacyDatabaseNames } from "@/lib/db/migrations";
import { resetDecryptConsent } from "@/lib/decryptConsent";
import { clearFoldedMemory } from "@/lib/foldedCache";
import {
  PUSH_CLEANUP_KEY,
  PUSH_INSTALLATION_KEY,
  stagePushCleanupForPurge,
} from "@/lib/pushRegistry";
import { clearShareShortcuts } from "@/lib/shareTarget";
import { writePushDisabledFlag } from "@/lib/swPushDisabled";
import { WEB_PUSH_RETIREMENT_KEY } from "@/lib/webPushEndpoint";

/**
 * localStorage keys that must survive a purge. `armada:login` is the nostrify
 * login store: it's mutated by `removeLogin` in the same tick we purge, and
 * blowing it away here would race that update and resurrect a stale session.
 * We clear it (and everything else) only as the final account logs out.
 */
const PRESERVE_LOCAL_STORAGE_KEYS = new Set<string>([
  "armada:login",
  // The next account must still know whether the outgoing browser endpoint
  // was actually retired after final logout's broad storage purge.
  WEB_PUSH_RETIREMENT_KEY,
]);

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
      // Every pre-ArmadaDB database, from the migration catalogue rather than a
      // second hand-maintained list: a purge has to delete them whether or not
      // the migration has run yet.
      ...legacyDatabaseNames(),
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
function purgeLocalStorage(preservePushCleanup: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    const preserve = preservePushCleanup
      ? new Set([...PRESERVE_LOCAL_STORAGE_KEYS, PUSH_CLEANUP_KEY, PUSH_INSTALLATION_KEY])
      : PRESERVE_LOCAL_STORAGE_KEYS;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && !preserve.has(key)) toRemove.push(key);
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
 * in the same tick. A hash-only failed-push cleanup tombstone and its opaque
 * installation id also survive only while a gateway delete remains pending;
 * everything else (including `armada:app-config`) is wiped so the next session
 * starts truly clean.
 */
export async function purgeClientStorage(outgoingPubkey?: string | null): Promise<void> {
  // The bounded gateway teardown can time out. Before its ordinary scoped
  // registry is wiped, retain only this account/current installation's opaque
  // ids under a hash-only tombstone so the same signer can retry after login.
  const preservePushCleanup = stagePushCleanupForPurge(outgoingPubkey);
  clearRenderedPlaintext();
  // Decrypted plaintext and decoded community state held in memory in front
  // of the stores purged below.
  clearRecentDecrypts();
  clearFoldedMemory();
  resetDecryptConsent();
  // The KV-backed caches (drafts, relay info, emoji palettes, GIF shards) keep
  // their own copy in memory. Deleting the database underneath them would
  // leave the next account reading the previous one's data straight out of it.
  resetKvCaches();
  // The Android share sheet keeps what was published to it until it is told
  // otherwise, so the suggestions would go on naming the previous account's
  // conversations, wearing their avatars, and deep-linking into rooms the next
  // account may not be in. Not awaited with the rest: it is a system call that
  // can be rate-limited, and no other teardown step depends on it.
  void clearShareShortcuts();
  purgeLocalStorage(preservePushCleanup);
  // ArmadaDB first: `deleteDatabase` against an open connection is blocked,
  // not applied, so its databases have to be closed before the sweep runs.
  await purgeArmadaDB();
  await Promise.all([purgeIndexedDB(), purgeCacheStorage(), purgeOrphanedOpfs()]);
  // Gateway records and a browser endpoint can outlive the bounded pre-logout
  // cleanup. Recreate ONLY the worker's kill switch after Cache Storage was
  // swept, so any late/stale push tears its endpoint down instead of notifying
  // a logged-out browser. A later explicit enable clears this flag first.
  await writePushDisabledFlag();
  // Again, afterwards. A cache warm already in flight when the first reset ran
  // resolves against the OLD database and refills the map behind us; the reset
  // is idempotent and costs nothing, and this is the last word. The same goes
  // for a decrypt or fold read that was in flight during the purge.
  resetKvCaches();
  clearRecentDecrypts();
  clearFoldedMemory();
}
