import { useNostr } from "@nostrify/react";
import { nip19 } from "nostr-tools";
import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { APP_CONFIG_STORAGE_KEY, seedAccountConfig } from "@/lib/activeAccount";
import { publishSignedEventToRelays, uniqueRelayUrls } from "@/lib/nip65";
import { buildSignupLists, type SignupSetup } from "@/lib/signupLists";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A freshly generated account's lists ({@link buildSignupLists}), in two parts.
 * `seed` runs BEFORE login and only points the account at its home relays
 * (`updateConfig` still names the outgoing account then), so the profile step
 * publishes there. `publish` runs from the relay step, after login, so NIP-42
 * AUTH relays get the new signer; it re-sends the profile to the chosen relays.
 */
export function useSignupLists() {
  const { nostr } = useNostr();
  const { updateConfig } = useAppContext();

  const seed = useCallback((pubkey: string, homeRelays: string[]) => {
    seedAccountConfig(APP_CONFIG_STORAGE_KEY, pubkey, { appRelays: homeRelays });
  }, []);

  const publish = useCallback((nsec: string, setup: SignupSetup, profile?: NostrEvent) => {
    let built: ReturnType<typeof buildSignupLists>;
    try {
      built = buildSignupLists(nip19.decode(nsec).data as Uint8Array, setup);
    } catch {
      return; // best effort; the account still works on its home relays
    }
    const { events, configSeed, discoverable } = built;
    updateConfig((current) => ({ ...current, ...configSeed }));
    for (const { event, relays } of events) {
      void publishSignedEventToRelays(nostr, event, relays, 8_000);
    }
    if (profile) {
      const reach = uniqueRelayUrls([...discoverable, ...(configSeed.broadcastRelays as string[])]);
      void publishSignedEventToRelays(nostr, profile, reach, 8_000);
    }
  }, [nostr, updateConfig]);

  return { seed, publish };
}
