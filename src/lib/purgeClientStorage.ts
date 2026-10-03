import { clearRevealedMedia } from "@/components/chat/revealedMedia";
import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { clearAudioMetadata } from "@/hooks/useAudioMetadata";
import { clearRecentDecrypts } from "@/lib/AppSigner";
import { ARMADA_DB_NAME, purgeArmadaDB } from "@/lib/db/armadaDB";
import { resetKvCaches } from "@/lib/db/kvCache";
import { resetDecryptConsent } from "@/lib/decryptConsent";
import { closeDmEphemeralSubs } from "@/lib/nip17/ephemeralInbox";
import { clearFoldedMemory } from "@/lib/foldedCache";
import { clearDeferredFoldMemory } from "@/concord/hooks/useDeferredFold";
import { clearSightingsMemory } from "@/concord/lib/mediaTrust";
import { clearPendingJoins } from "@/concord/lib/pendingJoins";
import { clearShareShortcuts } from "@/lib/shareTarget";
import { writePushDisabledFlag } from "@/lib/swPushDisabled";
import { WEB_PUSH_RETIREMENT_KEY } from "@/lib/webPushEndpoint";

/**
 * localStorage keys that survive a purge. `armada:login` is mutated by
 * `removeLogin` in the same tick; wiping it here would race that and
 * resurrect a stale session.
 */
const PRESERVE_LOCAL_STORAGE_KEYS = new Set<string>([
  "armada:login",
  // The next account needs to know whether the old browser endpoint was retired.
  WEB_PUSH_RETIREMENT_KEY,
]);

/**
 * Pre-ArmadaDB databases. Upgraded installs may still hold them (undrained, with
 * decrypted data), so logout keeps deleting them.
 */
const RETIRED_DATABASES = [
  "armada-concord-cache",
  "armada-decrypt-cache",
  "armada-concord-invites",
  "armada-dm17-rumors",
  "armada-concord-rumors",
  "armada-events",
  "armada-relay-provenance",
  "armada-concord-pending",
];

/** Remove the retired SQLite-WASM store's OPFS directory, still present on upgraded devices. */
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
    // `indexedDB.databases()` is unsupported on Firefox; fall back to known names.
    const known = [
      // Tenant DBs (`armada:t:<id>`) are deleted by `purgeArmadaDB`, which can close them first.
      `${ARMADA_DB_NAME}:kv`,
      ...RETIRED_DATABASES,
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
 * Purge all client-side persistence on logout (caches, decrypt cache, read
 * state, drafts, prefs, the push gateway's per-install client key, …).
 * `armada:login` is left to the caller's `removeLogin`.
 */
export async function purgeClientStorage(): Promise<void> {
  clearRenderedPlaintext();
  clearRecentDecrypts();
  clearFoldedMemory();
  clearDeferredFoldMemory();
  clearAudioMetadata();
  clearPendingJoins();
  clearSightingsMemory();
  clearRevealedMedia();
  resetDecryptConsent();
  // Shared DM ephemeral REQs linger past their last consumer; close them.
  closeDmEphemeralSubs();
  // KV-backed caches hold in-memory copies that would otherwise leak into the next account.
  resetKvCaches();
  // Android share-sheet suggestions would keep naming the old account's rooms.
  // Not awaited: a rate-limitable system call nothing else depends on.
  void clearShareShortcuts();
  purgeLocalStorage();
  // ArmadaDB first: `deleteDatabase` is blocked by open connections.
  await purgeArmadaDB();
  await Promise.all([purgeIndexedDB(), purgeCacheStorage(), purgeOrphanedOpfs()]);
  // Recreate only the worker's kill switch, so a late push tears its endpoint
  // down instead of notifying a logged-out browser.
  await writePushDisabledFlag();
  // Again: in-flight warms/reads may have refilled caches from the old database.
  resetKvCaches();
  clearRecentDecrypts();
  clearFoldedMemory();
  clearAudioMetadata();
  clearPendingJoins();
  clearSightingsMemory();
  clearRevealedMedia();
}
