import { useNostr } from "@nostrify/react";
import { nip19 } from "nostr-tools";
import { useCallback, useEffect, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { APP_CONFIG_STORAGE_KEY, seedAccountConfig } from "@/lib/activeAccount";
import { publishSignedEventToRelays } from "@/lib/nip65";
import { buildSignupLists, type SignupListEvent } from "@/lib/signupLists";

/**
 * Seeds a freshly generated account with its default lists ({@link buildSignupLists}).
 * `prepare` runs BEFORE login: it signs the lists and seeds the account's scoped
 * config (`updateConfig` still points at the outgoing account then). They are
 * published once the new account is active, so NIP-42 AUTH relays get its signer.
 */
export function useSignupLists(): (pubkey: string, nsec: string, homeRelays: string[]) => void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const pending = useRef<{ pubkey: string; events: SignupListEvent[] } | null>(null);

  useEffect(() => {
    const queued = pending.current;
    if (!queued || user?.pubkey !== queued.pubkey) return;
    pending.current = null;
    for (const { event, relays } of queued.events) {
      void publishSignedEventToRelays(nostr, event, relays, 8_000);
    }
  }, [user?.pubkey, nostr]);

  return useCallback((pubkey: string, nsec: string, homeRelays: string[]) => {
    let seed: Record<string, unknown> = { appRelays: homeRelays };
    try {
      const sk = nip19.decode(nsec).data as Uint8Array;
      const { events, configSeed } = buildSignupLists(sk, homeRelays);
      pending.current = { pubkey, events };
      seed = configSeed;
    } catch {
      // best effort; the account still works on the app relays
    }
    seedAccountConfig(APP_CONFIG_STORAGE_KEY, pubkey, seed);
  }, []);
}
