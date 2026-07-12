import { NSecSigner } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { type NLoginType, NUser, useNostrLogin } from "@nostrify/react/login";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo } from "react";

import { AppSigner } from "@/lib/AppSigner";
import {
  NConnectSignerBtc,
  NSecSignerBtc,
  NBrowserSignerBtc,
} from "@/lib/bitcoin-signers";

import { useAuthor } from "./useAuthor.ts";

export function useCurrentUser() {
  const { nostr } = useNostr();
  const { logins } = useNostrLogin();

  // Wrap the user-facing signer in an AppSigner so `nip04`/`nip44` `decrypt` is
  // served from the persistent content-addressed cache (huge win for
  // remote/extension signers). Wraps ONLY this signer — never the NIP-46
  // transport key below, nor the NIP-42 AUTH signer in NostrProvider.
  const cached = useCallback(
    (user: NUser): NUser =>
      new NUser(user.method, user.pubkey, new AppSigner(user.signer, user.pubkey)),
    [],
  );

  const loginToUser = useCallback((login: NLoginType): NUser => {
    switch (login.type) {
      case "nsec": {
        const sk = nip19.decode(login.data.nsec) as { type: "nsec"; data: Uint8Array };
        return cached(new NUser(login.type, login.pubkey, new NSecSignerBtc(sk.data)));
      }
      case "bunker": {
        const clientSk = nip19.decode(login.data.clientNsec) as { type: "nsec"; data: Uint8Array };
        const clientSigner = new NSecSigner(clientSk.data);
        const bunkerRelays = login.data.relays;

        return cached(
          new NUser(
            login.type,
            login.pubkey,
            new NConnectSignerBtc({
              relay: nostr.group(bunkerRelays),
              pubkey: login.data.bunkerPubkey,
              signer: clientSigner,
              timeout: 60_000,
            }),
          ),
        );
      }
      case "extension":
        return cached(
          new NUser(login.type, login.pubkey, new NBrowserSignerBtc()),
        );
      default:
        throw new Error(`Unsupported login type: ${login.type}`);
    }
  }, [nostr, cached]);

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
