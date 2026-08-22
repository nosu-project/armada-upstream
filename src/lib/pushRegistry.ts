/**
 * The device-local bookkeeping every nostr-push controller keeps.
 *
 * Shared by `useNostrPush` (Web Push) and `useIosPush` (APNs) — one device runs
 * only one of them, so they are the same three facts under the same three keys
 * rather than a per-platform copy that could disagree about what "on" means:
 *
 *  - the user's INTENT, which is not the same as the OS permission. Intent is
 *    opt-out and survives a revoked-then-regranted permission, so returning to
 *    the app repairs push instead of silently leaving it off.
 *  - the per-type prefs, which are account-global and shared with the Android
 *    service and the in-app notifier too (see `pushPrefs.ts`).
 *  - the subscription ids last registered with the gateway. Registrations are
 *    SERVER-side and outlive the process, so this is the only durable record of
 *    what needs pruning when the watch set shrinks — and, on a cold start, the
 *    only way to tell "nothing to watch yet" from "was watching, now nothing".
 */

import {
  savePushPrefs as saveAccountPushPrefs,
  type PushPrefs,
} from "@/lib/pushPrefs";
import { scopePushSubscriptionId } from "@/lib/pushSubscriptions";

const INTENT_KEY = "armada:push-intent";
const SUBS_KEY = "armada:nostr-push-subs";
const SCOPED_SUBS_KEY = "armada:nostr-push-subs:v2";
/** Opaque cleanup state that may outlive a final-logout storage purge. */
export const PUSH_CLEANUP_KEY = "armada:nostr-push-cleanup:v1";
/** Stable browser/app installation identity paired with the cleanup state. */
export const PUSH_INSTALLATION_KEY = "armada:push-install";

export interface PushRegistryScope {
  pubkey: string;
  domain: string;
  installation: string;
}

export interface PushRegistrationState {
  ids: string[];
  /** Whether this install has registered installation-scoped ids and pruned its web legacy ids. */
  legacyMigrationComplete: boolean;
}

interface StoredPushRegistrationState {
  ids: string[];
  legacyMigrationComplete?: boolean;
}

type ScopedPushRegistry = Record<string, StoredPushRegistrationState>;

/**
 * Final purge cannot cancel an async exit handler that already timed out.
 * Fence its account/install for the remainder of this document so any late
 * reconciliation save stays in the hash-only tombstone instead of recreating
 * the raw scoped registry after it was wiped. A hard reload naturally clears
 * this set before a legitimate relogin consumes the tombstone.
 */
const purgeFencedAccounts = new Set<string>();

function uniqueSortedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string"))].sort();
}

/** Stable map key. Account + origin + install prevents one login pruning another's records. */
export function pushRegistryScopeKey(scope: PushRegistryScope): string {
  return JSON.stringify([
    scope.domain.toLowerCase(),
    scope.pubkey.toLowerCase(),
    scope.installation,
  ]);
}

function loadRegistry(storageKey: string): ScopedPushRegistry {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean: ScopedPushRegistry = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Partial<StoredPushRegistrationState>;
      clean[key] = {
        ids: uniqueSortedIds(record.ids),
        legacyMigrationComplete: record.legacyMigrationComplete === true,
      };
    }
    return clean;
  } catch {
    return {};
  }
}

function loadScopedRegistry(): ScopedPushRegistry {
  return loadRegistry(SCOPED_SUBS_KEY);
}

function loadCleanupRegistry(): ScopedPushRegistry {
  return loadRegistry(PUSH_CLEANUP_KEY);
}

function saveRegistry(
  storageKey: string,
  registry: ScopedPushRegistry,
  removeWhenEmpty = false,
): boolean {
  try {
    if (removeWhenEmpty && Object.keys(registry).length === 0) {
      localStorage.removeItem(storageKey);
    } else {
      localStorage.setItem(storageKey, JSON.stringify(registry));
    }
    return true;
  } catch {
    return false;
  }
}

function saveScopedRegistry(registry: ScopedPushRegistry): boolean {
  return saveRegistry(SCOPED_SUBS_KEY, registry);
}

function saveCleanupRegistry(registry: ScopedPushRegistry): boolean {
  return saveRegistry(PUSH_CLEANUP_KEY, registry, true);
}

/** Hash-only key: the preserved tombstone never contains a raw account pubkey. */
function pushCleanupScopeKey(scope: PushRegistryScope): string {
  return scopePushSubscriptionId(
    "cleanup",
    scope.pubkey,
    scope.domain,
    scope.installation,
  );
}

function pushCleanupAccountKey(pubkey: string, installation: string): string {
  return scopePushSubscriptionId("cleanup-account", pubkey, "", installation);
}

function parsePushRegistryScopeKey(key: string): PushRegistryScope | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      !Array.isArray(parsed)
      || parsed.length !== 3
      || parsed.some((part) => typeof part !== "string")
    ) return undefined;
    return {
      domain: parsed[0] as string,
      pubkey: parsed[1] as string,
      installation: parsed[2] as string,
    };
  } catch {
    return undefined;
  }
}

function consumePushCleanup(scope: PushRegistryScope): void {
  const cleanup = loadCleanupRegistry();
  const key = pushCleanupScopeKey(scope);
  if (!cleanup[key]) return;
  delete cleanup[key];
  saveCleanupRegistry(cleanup);
}

/**
 * Snapshot only the outgoing account/current installation's unresolved ids
 * into a hash-keyed, nonsecret tombstone before a final storage purge.
 *
 * Returns whether the purge must preserve the cleanup key and stable
 * installation id. Fencing an account is sufficient even before an orphan id
 * exists, because a timed-out first PUT may create one later. Passing no
 * account stages nothing but still protects an already-pending tombstone.
 */
export function stagePushCleanupForPurge(pubkey?: string | null): boolean {
  const cleanup = loadCleanupRegistry();
  let fencedInstallation = false;
  if (pubkey) {
    try {
      const installation = localStorage.getItem(PUSH_INSTALLATION_KEY);
      if (installation) {
        fencedInstallation = true;
        const normalizedPubkey = pubkey.toLowerCase();
        // Set before any subsequent storage work: a timed-out handler can
        // resume at any await boundary while purge is staging its tombstone.
        purgeFencedAccounts.add(pushCleanupAccountKey(normalizedPubkey, installation));
        let changed = false;
        for (const [key, record] of Object.entries(loadScopedRegistry())) {
          const scope = parsePushRegistryScopeKey(key);
          if (
            !scope
            || scope.pubkey.toLowerCase() !== normalizedPubkey
            || scope.installation !== installation
          ) continue;
          const ids = uniqueSortedIds(record.ids);
          if (ids.length === 0) continue;
          const cleanupKey = pushCleanupScopeKey(scope);
          const existing = cleanup[cleanupKey];
          cleanup[cleanupKey] = {
            ids: uniqueSortedIds([...(existing?.ids ?? []), ...ids]),
            legacyMigrationComplete:
              existing?.legacyMigrationComplete === true
              || record.legacyMigrationComplete === true,
          };
          changed = true;
        }
        if (changed) saveCleanupRegistry(cleanup);
      }
    } catch {
      // Storage unavailable: the ordinary scoped registry remains best-effort.
    }
  }
  // Preserve the opaque installation id as soon as this document is fenced,
  // even when the current prune set is empty. A first-ever gateway PUT may
  // still commit after the bounded exit window; its late save needs this exact
  // id to create a tombstone the same signer can consume after the hard reload.
  return fencedInstallation || Object.keys(loadCleanupRegistry()).length > 0;
}

/** Whether the user still intends push to be on (opt-out; default true). */
export function loadPushIntent(): boolean {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

export function savePushIntent(on: boolean): void {
  try {
    localStorage.setItem(INTENT_KEY, String(on));
  } catch {
    // ignore
  }
}

export function savePushPrefs(prefs: PushPrefs, pubkey?: string | null): void {
  saveAccountPushPrefs(prefs, pubkey);
}

/** The subscription ids we last registered — the prune list. */
export function loadRegisteredPushIds(): string[] {
  try {
    const raw = localStorage.getItem(SUBS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === "string");
      }
    }
  } catch {
    // ignore
  }
  return [];
}

export function saveRegisteredPushIds(ids: string[]): void {
  try {
    localStorage.setItem(SUBS_KEY, JSON.stringify(uniqueSortedIds(ids)));
  } catch {
    // ignore
  }
}

/**
 * Load this account/install's durable prune set.
 *
 * `legacyIds` are the no-installation ids the current logical specs used in
 * older web builds. Until migration completes they are included even when the
 * old flat registry was evicted, so an authoritative sync can release their
 * quota slot and replace them with installation-scoped records.
 *
 * The old flat registry can contain another account after an account switch.
 * Only ids carrying THIS account/domain's legacy digest are adopted; a signer
 * must never try to delete a different account's opaque records.
 */
export function loadPushRegistrationState(
  scope: PushRegistryScope,
  legacyIds: readonly string[] = [],
): PushRegistrationState {
  const registry = loadScopedRegistry();
  const stored = registry[pushRegistryScopeKey(scope)];
  const pendingCleanup = loadCleanupRegistry()[pushCleanupScopeKey(scope)];
  const complete = stored?.legacyMigrationComplete === true
    || pendingCleanup?.legacyMigrationComplete === true;
  const ids = new Set([...(stored?.ids ?? []), ...(pendingCleanup?.ids ?? [])]);

  if (!complete) {
    const legacySuffix = scopePushSubscriptionId(
      "",
      scope.pubkey,
      scope.domain,
    );
    for (const id of loadRegisteredPushIds()) {
      if (id.endsWith(legacySuffix)) ids.add(id);
    }
    for (const id of legacyIds) ids.add(id);
  }

  return { ids: [...ids].sort(), legacyMigrationComplete: complete };
}

/** Replace one account/install's prune state without disturbing other logins. */
export function savePushRegistrationState(
  scope: PushRegistryScope,
  state: PushRegistrationState,
): void {
  const ids = uniqueSortedIds(state.ids);
  if (purgeFencedAccounts.has(pushCleanupAccountKey(scope.pubkey, scope.installation))) {
    const cleanup = loadCleanupRegistry();
    const cleanupKey = pushCleanupScopeKey(scope);
    if (ids.length === 0) {
      delete cleanup[cleanupKey];
    } else {
      cleanup[cleanupKey] = {
        ids,
        legacyMigrationComplete: state.legacyMigrationComplete,
      };
    }
    saveCleanupRegistry(cleanup);
    return;
  }

  const registry = loadScopedRegistry();
  const key = pushRegistryScopeKey(scope);
  // Keep an empty completed entry: without its migration latch, the next load
  // would synthesize the legacy ids again and DELETE them on every sync.
  registry[key] = {
    ids,
    legacyMigrationComplete: state.legacyMigrationComplete,
  };
  // Consume the matching tombstone only after the merged state has a durable
  // ordinary home again. A crash between load and save therefore retries the
  // orphan cleanup instead of forgetting it.
  if (saveScopedRegistry(registry)) consumePushCleanup(scope);
}

/**
 * Finish the web-id migration and remove only this account/domain's entries
 * from the pre-v2 flat registry. Failed deletes remain in the scoped state and
 * therefore never reach this function.
 */
export function completePushIdMigration(
  scope: PushRegistryScope,
  ids: readonly string[],
): void {
  savePushRegistrationState(scope, {
    ids: [...ids],
    legacyMigrationComplete: true,
  });
  const legacySuffix = scopePushSubscriptionId("", scope.pubkey, scope.domain);
  const remaining = loadRegisteredPushIds().filter((id) => !id.endsWith(legacySuffix));
  saveRegisteredPushIds(remaining);
}

/**
 * A stable id for this browser/app install.
 *
 * nostr-push registration is replace-by-id, so two browsers at one origin
 * need different ids just as two native devices do. Local storage makes the
 * value stable across ordinary reloads; a storage reset intentionally creates
 * a new install identity. When storage is unavailable the session-only value
 * still avoids sharing another install's record.
 */
let ephemeralInstallationId: string | undefined;
export function pushInstallationId(): string {
  try {
    const existing = localStorage.getItem(PUSH_INSTALLATION_KEY);
    if (existing) return existing;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(PUSH_INSTALLATION_KEY, id);
    return id;
  } catch {
    // Private mode / storage disabled — use one stable value for this session.
  }
  if (!ephemeralInstallationId) {
    ephemeralInstallationId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return ephemeralInstallationId;
}
