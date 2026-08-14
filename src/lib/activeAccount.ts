/**
 * Which account is active, as a synchronously-readable signal.
 *
 * `logins[0]` is the active account (see `useCurrentUser`), but the component
 * that owns that array — `NostrLoginProvider` — sits BELOW `AppProvider` in the
 * tree, and its storage is async on native (the Keychain/KeyStore round-trip in
 * `secureStorage`). So the one thing that has to pick an account-scoped
 * storage key on its very first render cannot ask React for it.
 *
 * This module is that answer: a plain-localStorage marker, read synchronously
 * at module load, and kept current by `ActiveAccountSync` (mounted inside the
 * login provider, which is the only place `logins[0]` is knowable). It is a
 * MIRROR, never the source of truth — `armada:login` remains that, and a marker
 * that disagrees costs at most one re-render once the real list resolves.
 *
 * Deliberately NOT a secret and deliberately not in `secureStorage`: a pubkey
 * is public, and putting it behind an async read would defeat the entire point.
 */

/** Where the active account's pubkey is mirrored for synchronous reads. */
const ACTIVE_PUBKEY_KEY = "armada:active-pubkey";

/**
 * Which account claimed the pre-scoping `armada:app-config` blob.
 *
 * Before config was account-scoped there was ONE blob shared by every account
 * on the device. On upgrade it has to become somebody's — the account that was
 * active when the app last ran is the only honest answer — and it must become
 * exactly one account's, or every account would inherit the same DM peer list
 * and rail arrangement, which is the bug this scoping exists to fix.
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
 * Give the legacy unscoped `base` blob to `pubkey`, once, if it is unclaimed.
 *
 * Idempotent and synchronous, so it can run in render immediately before the
 * scoped key is read. A second account reaching this finds the claim taken and
 * starts from defaults — which its own NIP-78 settings documents then fill in,
 * rather than inheriting whatever the first account had.
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
 * Merge `patch` into `pubkey`'s stored config, for an account that is not
 * active yet.
 *
 * The signup wizard is the caller: it settles an account's home relays and its
 * freshly-published kind-10002 mirror BEFORE `login.nsec` makes that account
 * active. Routing those through `updateConfig` would write them to whichever
 * account is active at the time — the previous one, or the unscoped blob — and
 * the new account would then read a config that never received them. Writing
 * the target account's key directly makes the destination explicit instead of
 * a consequence of when the marker happens to flip relative to an effect.
 *
 * Merged shallowly over whatever is stored. `AppProvider` validates every field
 * on read, so a patch it can't parse costs that field and nothing else.
 */
export function seedAccountConfig(
  base: string,
  pubkey: string,
  patch: Record<string, unknown>,
): void {
  // Adopt first: on a fresh install the account being created is the one that
  // should inherit anything set before login (a theme picked on the landing
  // page). Adoption is skipped once the scoped key exists, so this stays a
  // one-time handover rather than something the seed can re-trigger.
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
      // An unparseable blob is already unusable — `AppProvider` reads it as
      // defaults. Seeding over it is strictly better than dropping the seed,
      // which is this account's home relays.
    }
    localStorage.setItem(scoped, JSON.stringify({ ...current, ...patch }));
  } catch {
    // The account still works on default relays; nothing here is load-bearing.
  }
}

/** Test seam: forget the in-memory marker so a suite can start from storage. */
export function _resetActiveAccountForTests(): void {
  active = readMarker();
  listeners.clear();
}
