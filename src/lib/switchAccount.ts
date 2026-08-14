import { secureStorage } from "@/lib/secureStorage";
import { setActivePubkey } from "@/lib/activeAccount";

import type { NLoginType } from "@nostrify/react/login";

/**
 * Where `NostrLoginProvider` keeps the login list. Declared here rather than
 * inline in `App.tsx` because switching accounts writes that list DIRECTLY (see
 * below), and two spellings of this key would mean a switch that persists
 * nowhere the next boot reads.
 */
export const LOGIN_STORAGE_KEY = "armada:login";

/** The login list with `id` moved to the front — `logins[0]` is the active one. */
export function reorderLogins(
  logins: readonly NLoginType[],
  id: string,
): NLoginType[] | null {
  const target = logins.find((login) => login.id === id);
  if (!target) return null;
  return [target, ...logins.filter((login) => login.id !== id)];
}

/**
 * Persist `logins` as the login list and hard-reload at `destination`.
 *
 * The reload is the point. Changing which account is active has to invalidate
 * every derived view of the previous one, and those live in far more places
 * than any teardown function could enumerate: the whole React Query cache,
 * module-level memo maps, fold caches, open relay subscriptions. Changing it in
 * place left the incoming account looking at the outgoing one's DM list and
 * communities, which is the leak this exists to close. A reload is the only
 * teardown that is complete by construction, and it costs a cold boot on an
 * action users take rarely and already expect to be disruptive.
 *
 * It deliberately does NOT rely on `setLogin`/`removeLogin` to persist. Those
 * dispatch a reducer and write from an EFFECT (`storage.setItem` in
 * `NostrLoginProvider`), which is both async and not guaranteed to have run
 * before `location.assign` tears the page down — a switch that reloads into the
 * account it just left. Writing the list here and awaiting it makes persistence
 * a precondition of the reload instead of a race against it. Nothing else
 * writes this key while the account menu is open, so there is no lost update.
 *
 * The `activeAccount` marker is set first and synchronously, so the next boot's
 * very first render — before the async keychain read resolves — already picks
 * the incoming account's scoped config key rather than flashing the outgoing
 * account's.
 */
async function persistAndReload(
  logins: readonly NLoginType[],
  destination: string,
): Promise<void> {
  setActivePubkey(logins[0]?.pubkey ?? null);

  try {
    await secureStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(logins));
  } catch {
    // A failed write means the reload lands back where storage already was.
    // Reloading anyway is still the honest outcome: the app then matches what
    // storage actually says, rather than showing a change that didn't persist.
  }

  window.location.assign(destination);
}

/** Make `id` the active account and reload the app at the root. */
export async function switchAccount(
  logins: readonly NLoginType[],
  id: string,
): Promise<void> {
  const reordered = reorderLogins(logins, id);
  if (!reordered) return;
  await persistAndReload(reordered, "/");
}

/**
 * Sign `id` out when other accounts remain, promoting the next one.
 *
 * This is a switch wearing a different hat: `logins[0]` changes, so the
 * outgoing account's caches would otherwise be exactly as visible to the
 * incoming one as they are on the switch path. Signing out the LAST account is
 * a different operation — `purgeClientStorage` plus a redirect to the landing
 * page — and stays with its caller.
 */
export async function signOutAccount(
  logins: readonly NLoginType[],
  id: string,
): Promise<void> {
  const remaining = logins.filter((login) => login.id !== id);
  if (remaining.length === 0) return;
  await persistAndReload(remaining, "/");
}
