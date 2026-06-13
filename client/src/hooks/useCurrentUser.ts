import { NConnectSigner, NSecSigner } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { type NLoginType, NUser, useNostrLogin } from "@nostrify/react/login";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo } from "react";

import { useAuthor } from "./useAuthor.ts";

export function useCurrentUser() {
  const { nostr } = useNostr();
  const { logins } = useNostrLogin();

  const loginToUser = useCallback((login: NLoginType): NUser => {
    switch (login.type) {
      case "nsec": {
        const sk = nip19.decode(login.data.nsec) as { type: "nsec"; data: Uint8Array };
        return new NUser(login.type, login.pubkey, new NSecSigner(sk.data));
      }
      case "bunker": {
        const clientSk = nip19.decode(login.data.clientNsec) as { type: "nsec"; data: Uint8Array };
        const clientSigner = new NSecSigner(clientSk.data);
        const bunkerRelays = login.data.relays;

        return new NUser(
          login.type,
          login.pubkey,
          new NConnectSigner({
            relay: nostr.group(bunkerRelays),
            pubkey: login.data.bunkerPubkey,
            signer: clientSigner,
            timeout: 60_000,
          }),
        );
      }
      case "extension":
        return NUser.fromExtensionLogin(login);
      default:
        throw new Error(`Unsupported login type: ${login.type}`);
    }
  }, [nostr]);

  const users = useMemo(() => {
    const users: NUser[] = [];
    for (const login of logins) {
      try {
        users.push(loginToUser(login));
      } catch (error) {
        console.warn("Skipped invalid login", login.id, error);
      }
    }
    return users;
  }, [logins, loginToUser]);

  const user = users[0] as NUser | undefined;
  const author = useAuthor(user?.pubkey);

  return {
    user,
    users,
    ...author.data,
    isLoading: author.isLoading,
  };
}
