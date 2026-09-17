import { secureStorage } from "@/lib/secureStorage";
import { getActivePubkey, setActivePubkey } from "@/lib/activeAccount";
import {
  EXIT_NAV_DEADLINE_MS,
  EXIT_TEARDOWN_MS,
  runBeforeAccountExit,
} from "@/lib/beforeAccountExit";
import { beginCrossTabAccountExit } from "@/lib/crossTabAccountExit";
import { beginAccountExit, exitDone, exitStep } from "@/components/accountExitState";

import type { NLoginType } from "@nostrify/react/login";

/**
 * Where `NostrLoginProvider` keeps the login list. Declared here rather than
 * inline in `App.tsx` because switching accounts writes that list DIRECTLY (see
 * below), and two spellings of this key would mean a switch that persists
 * nowhere the next boot reads.
 */
export const LOGIN_STORAGE_KEY = "armada:login";

/** Wrap a navigation so the deadline and the teardown can both call it, once. */
function navigateOnce(destination: string): () => void {
  let went = false;
  return () => {
    if (went) return;
    went = true;
    window.location.assign(destination);
  };
}

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
 * The `activeAccount` marker is set synchronously after login persistence, so
 * the next boot's very first render picks the incoming account's scoped config
 * and follower tabs cannot reload before the new login order is durable.
 */
async function persistAndReload(
  logins: readonly NLoginType[],
  destination: string,
): Promise<void> {
  const outgoingPubkey = getActivePubkey();
  // Raise the full-screen exit overlay before the bounded teardown below —
  // every caller here (switch, add-and-switch, sign-out) ends in a hard reload,
  // and until it lands the app would otherwise sit silently on the outgoing
  // account's screen. Idempotent: a caller that already raised it (the account
  // menu) wins, seed and all.
  beginAccountExit("switch", outgoingPubkey ?? "");
  // Navigate on an absolute deadline no matter what the teardown does, so a
  // stalled handler or a silent native bridge can never trap the switch on the
  // old screen. The teardown races it and, normally, wins.
  const go = navigateOnce(destination);
  const deadline = setTimeout(go, EXIT_NAV_DEADLINE_MS);

  // Fence every tab before the leader performs any origin-global endpoint or
  // worker-config teardown. Followers wait for the active marker and reload;
  // only this tab runs destructive before-exit handlers.
  beginCrossTabAccountExit(outgoingPubkey, logins[0]?.pubkey ?? null);
  // Gateway/native records are signed/configured by the OUTGOING account.
  // Give their controllers a bounded cleanup window before changing the
  // active marker or hard-reloading away the only session that can remove them.
  exitStep("teardown", "closing secure channel");
  await runBeforeAccountExit("account-change", EXIT_TEARDOWN_MS);

  exitStep("persist", "handing over identity");
  let persisted = false;
  try {
    await secureStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify(logins));
    persisted = true;
  } catch {
    // A failed write means the reload lands back where storage already was.
    // Reloading anyway is still the honest outcome: the app then matches what
    // storage actually says, rather than showing a change that didn't persist.
  }
  // Never point account-scoped config at an identity the durable login list
  // rejected. Reloading the outgoing identity also lets its controller repair
  // the endpoint that the pre-exit safety pass deliberately retired.
  setActivePubkey(persisted ? (logins[0]?.pubkey ?? null) : outgoingPubkey);

  exitDone("re-jacking in");
  clearTimeout(deadline);
  go();
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
 * Add a newly authenticated identity and make it active when another account
 * is already mounted. This must not dispatch `addLogin`/`setLogin` in-place:
 * doing so changes the signer before the outgoing notification/session cleanup
 * runs and leaves every account-keyed cache mounted across the transition.
 */
export async function addAndSwitchAccount(
  logins: readonly NLoginType[],
  login: NLoginType,
): Promise<void> {
  const next = [login, ...logins.filter((existing) => existing.id !== login.id)];
  await persistAndReload(next, "/");
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
