import { useNostrLogin } from "@nostrify/react/login";
import { useEffect, useRef, useState } from "react";

import { getBootPubkey } from "@/lib/activeAccount";

/**
 * A pubkey whose imminent fresh login should NOT raise the sync gate. Set by
 * the account-creation wizard right before it logs the new key in: a brand-new
 * account has no settings, no group list and no communities to catch up on, so
 * blocking onboarding behind a (network-bound, seconds-long on mobile) sync
 * overlay is pointless and hides the profile/community wizard steps. The next
 * fresh login for this pubkey is silently absorbed into the seen-baseline.
 */
let suppressedFreshPubkey: string | undefined;

/**
 * Mark the next fresh login as a wizard signup so {@link useFreshLogin} skips
 * the sync gate for it. Idempotent; cleared once consumed.
 */
export function suppressNextSyncGate(pubkey: string): void {
  suppressedFreshPubkey = pubkey;
}

/**
 * Detects a *fresh* login: a user who just authenticated in this session, as
 * opposed to a session that was simply restored from storage on a cold start /
 * reload (an in-session account switch hard-reloads, so it lands as a restored
 * boot session next load, not a fresh login — see below).
 *
 * The distinction matters for the post-login sync gate: a reload already has
 * everything in the IndexedDB cache and should render instantly, but a brand
 * new login needs to pull settings + the group list + an initial message
 * catch-up before the app is trustworthy. Showing the blocking sync spinner on
 * every reload would just flash an annoying overlay over cached data.
 *
 * How it works: the pubkey signed in at app BOOT (captured at module load in
 * `activeAccount`, before the provider tree or the lazy per-account services
 * mount) is the "restored" baseline. Any pubkey that becomes active without
 * having been signed in at boot is a fresh login. The result is the fresh
 * pubkey, or `undefined` once it's been acknowledged/cleared.
 *
 * The baseline is the boot marker rather than the login list at mount because
 * this hook mounts LATE: the sync gate lives in a lazy per-account chunk gated
 * on `user`, so by the time it mounts the fresh login is already in `logins`.
 * Seeding from `logins` here would fold every fresh login into the baseline and
 * the gate would never raise. `activeAccount`'s boot snapshot predates the
 * login, so a restored session matches it and a fresh login does not. (Account
 * switches hard-reload, so the switched-to account is a boot account next load.)
 *
 * A signup from the account wizard opts out via {@link suppressNextSyncGate}:
 * its pubkey is folded into the baseline without ever raising the gate.
 */
export function useFreshLogin(): {
  /** The pubkey of a just-completed fresh login, or `undefined`. */
  freshPubkey: string | undefined;
  /** Call once the sync for `freshPubkey` is finished so the gate dismisses. */
  acknowledge: () => void;
} {
  const { logins } = useNostrLogin();
  const activePubkey = logins[0]?.pubkey;

  // Pubkeys we already knew about at startup (restored from storage) plus any
  // we've already gated through this session. Seeded from the BOOT marker, not
  // the mount-time login list: this hook mounts inside a lazy per-account chunk
  // that only loads once `user` exists, so `logins` already holds the fresh
  // login by the time we run and would fold it into the baseline. The boot
  // snapshot predates the login, so a restored session is in it and a fresh
  // login is not. See the hook docstring.
  const seenRef = useRef<Set<string> | null>(null);
  if (seenRef.current === null) {
    const boot = getBootPubkey();
    seenRef.current = new Set(boot ? [boot] : []);
  }

  const [freshPubkey, setFreshPubkey] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!activePubkey) {
      // Logged out — clear any pending gate.
      setFreshPubkey(undefined);
      return;
    }
    const seen = seenRef.current!;
    if (!seen.has(activePubkey)) {
      seen.add(activePubkey);
      // A wizard signup opted out: fold it into the baseline (done above) but
      // never raise the gate for it. Consume the one-shot suppression.
      if (suppressedFreshPubkey === activePubkey) {
        suppressedFreshPubkey = undefined;
        return;
      }
      setFreshPubkey(activePubkey);
    }
  }, [activePubkey]);

  return {
    freshPubkey,
    acknowledge: () => setFreshPubkey(undefined),
  };
}
