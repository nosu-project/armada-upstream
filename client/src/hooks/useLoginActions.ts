import { useNostr } from "@nostrify/react";
import {
  NLogin,
  type NLoginType,
  type NostrConnectParams,
  type NostrConnectStatus,
  useNostrLogin,
} from "@nostrify/react/login";

import { useAppContext } from "@/hooks/useAppContext";
import { normalizeRelayUrl, PLATFORM_RELAYS } from "@/lib/platform";

export type { NostrConnectParams, NostrConnectStatus };
export { generateNostrConnectParams, generateNostrConnectURI } from "@nostrify/react/login";

export function useLoginActions() {
  const { nostr } = useNostr();
  const { logins, addLogin, setLogin, removeLogin } = useNostrLogin();
  const { config } = useAppContext();

  // Add a login and promote it to be the current user.
  const addAndActivate = (login: NLoginType) => {
    addLogin(login);
    setLogin(login.id);
  };

  return {
    // Login with a Nostr secret key
    nsec(nsec: string): void {
      const login = NLogin.fromNsec(nsec);
      addAndActivate(login);
    },
    // Login with a NIP-46 "bunker://" URI
    async bunker(uri: string): Promise<void> {
      const login = await NLogin.fromBunker(uri, nostr);
      addAndActivate(login);
    },
    // Login with a NIP-07 browser extension
    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      addAndActivate(login);
    },
    // Login via nostrconnect:// (client-initiated NIP-46)
    async nostrconnect(
      params: NostrConnectParams,
      signal?: AbortSignal,
      onStatus?: (status: NostrConnectStatus) => void,
    ): Promise<void> {
      const login = await NLogin.fromNostrConnect(params, nostr, { signal, onStatus });
      addAndActivate(login);
    },
    // Relay URLs used for NIP-46 nostrconnect communication. On an internal
    // deployment the platform relays are the rendezvous point.
    getRelayUrls(): string[] {
      const added = config.addedRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      return [...new Set([...PLATFORM_RELAYS, ...added])];
    },
    // Log out the current user
    async logout(): Promise<void> {
      const login = logins[0];
      if (login) {
        removeLogin(login.id);
      }
    },
  };
}
