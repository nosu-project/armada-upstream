/**
 * Device-local bookkeeping shared by `useNostrPush` (Web Push) and `useIosPush`
 * (APNs): the user's opt-out INTENT (distinct from OS permission, so push
 * repairs itself after a re-grant), per-type prefs (see `pushPrefs.ts`), and the
 * ids last registered with the gateway — the only durable record of what to
 * prune, since registrations are server-side.
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
 * Accounts/installs fenced by a final purge, so a timed-out exit handler's late
 * save goes to the hash-only tombstone instead of recreating the wiped
 * registry. Cleared by a hard reload.
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
 * Before a final purge, snapshot the outgoing account/install's unresolved ids
 * into a hash-keyed tombstone. Returns whether the purge must preserve the
 * cleanup key and installation id (always once fenced: a late PUT may still land).
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
        // Fence before any storage work: a timed-out handler can resume at any await.
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
  // Keep the installation id once fenced, even with nothing to prune: a late
  // first PUT needs it to create a consumable tombstone.
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
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }
  return [];
}

export function saveRegisteredPushIds(ids: string[]): void {
  try {
    localStorage.setItem(SUBS_KEY, JSON.stringify(uniqueSortedIds(ids)));
  } catch { /* ignore */ }
}

/**
 * Load this account/install's durable prune set. Until migration completes,
 * includes the legacy (no-installation) web ids so they can be released. Only
 * ids with THIS account/domain's legacy digest are adopted from the old flat
 * registry — never another account's.
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
  // Keep the completed entry, or the next load re-synthesizes legacy ids and deletes them every sync.
  registry[key] = {
    ids,
    legacyMigrationComplete: state.legacyMigrationComplete,
  };
  // Consume the tombstone only after the merged state is durably saved, so a crash retries cleanup.
  if (saveScopedRegistry(registry)) consumePushCleanup(scope);
}

/** Finish the web-id migration: drop this account/domain's entries from the pre-v2 flat registry. */
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
 * Stable id for this browser/app install: registration is replace-by-id, so
 * installs must differ. Session-only when storage is unavailable.
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
  } catch { /* ignore */ }
  if (!ephemeralInstallationId) {
    ephemeralInstallationId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return ephemeralInstallationId;
}
