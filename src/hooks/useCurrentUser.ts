import { NSecSigner } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { type NLoginType, NUser, useNostrLogin } from "@nostrify/react/login";
import { nip19 } from "nostr-tools";
import { useCallback, useMemo } from "react";

import { AppSigner } from "@/lib/AppSigner";
import {
  NSecSignerBtc,
  NBrowserSignerBtc,
} from "@/lib/bitcoin-signers";
import { Nip46Signer } from "@/lib/nip46Signer";
import { getNip46Transport } from "@/lib/nip46Transport";
import { logSync } from "@/lib/syncLog";

import { useAuthor } from "./useAuthor.ts";

/**
 * ONE NUser (and thus ONE signer) per (nostr instance, login id), app-wide.
 *
 * `useCurrentUser` is called from dozens of components; building the user in
 * the hook meant every call site constructed its OWN signer. For a NIP-46
 * login that was pathological: N live NConnectSigner instances, each RPC
 * opening its own response subscription on every bunker relay (the on-device
 * trace showed 9 concurrent subs each receiving every response), N AppSigner
 * decrypt caches missing in parallel, and stale instances surviving with
 * captured transports whose sends silently vanish. Keyed weakly by the nostr
 * instance so a provider remount naturally invalidates the cache instead of
 * resurrecting a signer built on a closed pool.
 */
const userCache = new WeakMap<object, Map<string, NUser>>();

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
    let byLogin = userCache.get(nostr as object);
    if (!byLogin) {
      byLogin = new Map();
      userCache.set(nostr as object, byLogin);
    }
    const existing = byLogin.get(login.id);
    if (existing) return existing;

    const user = (() => {
      switch (login.type) {
        case "nsec": {
          const sk = nip19.decode(login.data.nsec) as { type: "nsec"; data: Uint8Array };
          return cached(new NUser(login.type, login.pubkey, new NSecSignerBtc(sk.data)));
        }
        case "bunker": {
          const clientSk = nip19.decode(login.data.clientNsec) as { type: "nsec"; data: Uint8Array };
          const clientSigner = new NSecSigner(clientSk.data);
          const bunkerRelays = login.data.relays;

          // The NIP-46 channel rides a DEDICATED plain-WebSocket transport —
          // not the relay pool. The pool stack (NRelay1/websocket-ts/NPool)
          // repeatedly wedged on Android into a state where new REQs/EVENTs
          // silently went nowhere, hanging every remote sign; plain sockets
          // with reconnect+resub never did (see nip46Transport.ts). The
          // signer keeps ONE persistent response subscription for the whole
          // session (see nip46Signer.ts) instead of churning a sub per RPC.
          const transport = getNip46Transport(login.data.bunkerPubkey, bunkerRelays);
          logSync("nip46", `building the app-wide bunker signer (login ${login.id.slice(0, 8)})`);

          return cached(
            new NUser(
              login.type,
              login.pubkey,
              new Nip46Signer({
                transport,
                bunkerPubkey: login.data.bunkerPubkey,
                clientSigner,
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
    })();
    byLogin.set(login.id, user);
    return user;
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
