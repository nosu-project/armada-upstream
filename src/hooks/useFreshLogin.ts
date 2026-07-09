import { useNostrLogin } from "@nostrify/react/login";
import { useEffect, useRef, useState } from "react";

/**
 * Detects a *fresh* login: a user who just authenticated (or a freshly switched
 * account), as opposed to a session that was simply restored from storage on a
 * cold start / reload.
 *
 * The distinction matters for the post-login sync gate: a reload already has
 * everything in the IndexedDB cache and should render instantly, but a brand
 * new login needs to pull settings + the group list + an initial message
 * catch-up before the app is trustworthy. Showing the blocking sync spinner on
 * every reload would just flash an annoying overlay over cached data.
 *
 * How it works: the set of login pubkeys present at mount is treated as the
 * "restored" baseline. Any pubkey that appears *after* mount (i.e. the active
 * pubkey changes to one we hadn't seen at startup) is a fresh login. The result
 * is the fresh pubkey, or `undefined` once it's been acknowledged/cleared.
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
  // we've already gated through this session. Seeded once on mount with the
  // restored logins so a reload never counts as fresh.
  const seenRef = useRef<Set<string> | null>(null);
  if (seenRef.current === null) {
    seenRef.current = new Set(logins.map((l) => l.pubkey));
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
      setFreshPubkey(activePubkey);
    }
  }, [activePubkey]);

  return {
    freshPubkey,
    acknowledge: () => setFreshPubkey(undefined),
  };
}
