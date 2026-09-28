/**
 * Synchronously-readable mirror of the active account (`logins[0]`), kept by
 * `ActiveAccountSync`. Needed because the login provider sits below
 * `AppProvider` and its storage is async on native. Not the source of truth
 * (`armada:login` is); a pubkey is public, so plain localStorage is fine.
 */

export const ACTIVE_PUBKEY_KEY = "armada:active-pubkey";

/**
 * Which account claimed the pre-scoping unscoped `armada:app-config` blob.
 * It must go to exactly one account, or all accounts would share it.
 */
const LEGACY_CLAIM_KEY = "armada:app-config:claimed-by";

/** Base key for the app config blob, scoped per account by {@link accountScopedKey}. */
export const APP_CONFIG_STORAGE_KEY = "armada:app-config";

function readMarker(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PUBKEY_KEY);
  } catch {
    return null;
  }
}

let active: string | null = readMarker();

/**
 * The active-account marker at module load (eagerly imported from `App.tsx`),
 * i.e. who was signed in at boot. `useFreshLogin` uses it to tell a restored
 * session from a fresh login (account switches hard-reload). Never mutated in-session.
 */
let bootPubkey: string | null = active;

export function getBootPubkey(): string | null {
  return bootPubkey;
}

const listeners = new Set<() => void>();

/** The active account's pubkey, or null when logged out. */
export function getActivePubkey(): string | null {
  return active;
}

/** Point the marker at `pubkey` (null when logged out) and notify subscribers. */
export function setActivePubkey(pubkey: string | null): void {
  if (pubkey === active) return;
  active = pubkey;
  try {
    if (pubkey) localStorage.setItem(ACTIVE_PUBKEY_KEY, pubkey);
    else localStorage.removeItem(ACTIVE_PUBKEY_KEY);
  } catch {
    // Private-mode/quota failures cost a re-read on next boot, nothing more.
  }
  for (const listener of [...listeners]) listener();
}

/** Subscribe to changes, in `useSyncExternalStore` shape. */
export function subscribeActivePubkey(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The localStorage key holding `base`'s config for one account. */
export function accountScopedKey(base: string, pubkey: string | null): string {
  return pubkey ? `${base}:${pubkey}` : base;
}

/**
 * Give the legacy unscoped `base` blob to `pubkey`, once, if unclaimed.
 * Idempotent and synchronous so it can run in render before the scoped read.
 */
export function adoptLegacyConfig(base: string, pubkey: string): void {
  try {
    const scoped = accountScopedKey(base, pubkey);
    if (localStorage.getItem(scoped) !== null) return;
    const claimedBy = localStorage.getItem(LEGACY_CLAIM_KEY);
    if (claimedBy !== null && claimedBy !== pubkey) return;
    const legacy = localStorage.getItem(base);
    if (legacy === null) return;
    localStorage.setItem(scoped, legacy);
    localStorage.setItem(LEGACY_CLAIM_KEY, pubkey);
  } catch {
    // Nothing to adopt is a valid outcome; defaults are a safe starting point.
  }
}

/**
 * Merge `patch` into `pubkey`'s stored config before that account is active
 * (signup wizard: `updateConfig` would write to the previously active account).
 * Shallow merge; `AppProvider` validates each field on read.
 */
export function seedAccountConfig(
  base: string,
  pubkey: string,
  patch: Record<string, unknown>,
): void {
  // Adopt first so the new account inherits pre-login settings (e.g. a theme).
  adoptLegacyConfig(base, pubkey);
  try {
    const scoped = accountScopedKey(base, pubkey);
    const raw = localStorage.getItem(scoped);
    let current: Record<string, unknown> = {};
    try {
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable blob already reads as defaults; seed over it.
    }
    localStorage.setItem(scoped, JSON.stringify({ ...current, ...patch }));
  } catch {
    // The account still works on default relays; nothing here is load-bearing.
  }
}

/** Test seam: re-read the marker and boot snapshot from storage. */
export function _resetActiveAccountForTests(): void {
  active = readMarker();
  bootPubkey = active;
  listeners.clear();
}
