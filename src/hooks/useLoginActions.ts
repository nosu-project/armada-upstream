import { Capacitor } from "@capacitor/core";
import { BunkerURI, NSecSigner } from "@nostrify/nostrify";
import {
  NLogin,
  type NLoginType,
  type NostrConnectParams,
  type NostrConnectStatus,
  useNostrLogin,
} from "@nostrify/react/login";
import { generateSecretKey, nip19 } from "nostr-tools";

import { useAppContext } from "@/hooks/useAppContext";
import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { Nip46Signer } from "@/lib/nip46Signer";
import { Nip46Transport, getNip46Transport, removeNip46Transport } from "@/lib/nip46Transport";
import { normalizeRelayUrl, PLATFORM_RELAYS } from "@/lib/platform";
import { purgeClientStorage } from "@/lib/purgeClientStorage";
import { clearWalletStorage } from "@/lib/walletStorage";
import { clearEsploraStorage } from "@/lib/esploraStorage";
import { logSync } from "@/lib/syncLog";

export type { NostrConnectParams, NostrConnectStatus };
export { generateNostrConnectParams, generateNostrConnectURI } from "@nostrify/react/login";

export function useLoginActions() {
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
    // Login with a NIP-46 "bunker://" URI.
    //
    // The pairing handshake rides the SAME dedicated plain-WebSocket
    // transport the session signer will use — never the relay pool, whose
    // socket machinery repeatedly wedged NIP-46 traffic on Android (see
    // nip46Transport.ts). Pairing over the pool was the first NIP-46 thing a
    // user did and the first thing that failed.
    async bunker(uri: string): Promise<void> {
      const { pubkey: bunkerPubkey, secret, relays } = new BunkerURI(uri);
      if (!relays.length) {
        throw new Error("No relay provided");
      }
      const clientSk = generateSecretKey();
      const transport = getNip46Transport(bunkerPubkey, relays);
      const signer = new Nip46Signer({
        transport,
        bunkerPubkey,
        clientSigner: new NSecSigner(clientSk),
      });
      try {
        await signer.connect(secret);
        const pubkey = await signer.getPublicKey();
        addAndActivate(
          new NLogin("bunker", pubkey, {
            bunkerPubkey,
            clientNsec: nip19.nsecEncode(clientSk),
            relays,
          }),
        );
      } catch (error) {
        // Pairing failed — don't leave the rejected attempt's sockets
        // reconnecting for the rest of the page's lifetime.
        removeNip46Transport(bunkerPubkey, relays);
        throw error;
      }
    },
    // Login with a NIP-07 browser extension
    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      addAndActivate(login);
    },
    // Login via nostrconnect:// (client-initiated NIP-46).
    //
    // Same dedicated-transport rule as bunker(): the wait for the signer's
    // connect-ack runs on a throwaway Nip46Transport — the bunker pubkey
    // isn't known until the ack arrives, so it can't share the session
    // transport yet. It is closed in `finally` either way; the session
    // signer (useCurrentUser) builds the keyed app-wide transport once the
    // login exists.
    async nostrconnect(
      params: NostrConnectParams,
      signal?: AbortSignal,
      onStatus?: (status: NostrConnectStatus) => void,
    ): Promise<void> {
      const clientSigner = new NSecSigner(params.clientSecretKey);
      const transport = new Nip46Transport(params.relays);
      const effectiveSignal = signal ?? AbortSignal.timeout(120_000);
      try {
        onStatus?.("awaiting-connect");
        const sub = transport.req([{ kinds: [24133], "#p": [params.clientPubkey] }], {
          signal: effectiveSignal,
        });
        for await (const msg of sub) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2];
          let response: { result?: unknown };
          try {
            response = JSON.parse(await clientSigner.nip44.decrypt(event.pubkey, event.content));
          } catch {
            continue; // Not addressed to us / undecryptable noise.
          }
          if (response?.result !== params.secret && response?.result !== "ack") continue;

          onStatus?.("getting-public-key");
          logSync("nip46", `nostrconnect ack from signer ${event.pubkey.slice(0, 8)} — fetching user pubkey`);
          const signer = new Nip46Signer({
            transport,
            bunkerPubkey: event.pubkey,
            clientSigner,
          });
          const userPubkey = await signer.getPublicKey();
          addAndActivate(
            new NLogin("bunker", userPubkey, {
              bunkerPubkey: event.pubkey,
              clientNsec: nip19.nsecEncode(params.clientSecretKey),
              relays: params.relays,
            }),
          );
          return;
        }
        // The subscription ended without a signer response: the caller
        // aborted (dialog closed/retried) or the default timeout fired.
        if (effectiveSignal.aborted) {
          const err = new Error("The nostrconnect handshake was aborted");
          err.name = "AbortError";
          throw err;
        }
        throw new Error("Timeout waiting for remote signer");
      } finally {
        transport.close();
      }
    },
    // Relay URLs used for NIP-46 nostrconnect communication. App relays come
    // first (remote signers are usually reachable through public relays),
    // then the internal platform/user servers as fallback rendezvous points.
    //
    // The list is FROZEN into the signer pairing for the lifetime of the
    // session (#48), so relays the signer can never reach must not enter it:
    //   - loopback relays are only reachable from THIS machine, never from a
    //     remote signer (a stale ws://localhost:5577 pairing had Amber retry
    //     it on every sign for weeks);
    //   - on a native build (secure WebView origin) non-wss relays are also
    //     unusable on OUR side (mixed content), so they'd be rendezvous
    //     points only the signer could reach — dead weight at best.
    // Non-loopback ws:// LAN relays stay on the web build: an air-gapped LAN
    // deployment with a LAN signer is a supported setup.
    getRelayUrls(): string[] {
      const appRelays = config.appRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const added = config.addedRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const all = [...new Set([...appRelays, ...PLATFORM_RELAYS, ...added])];
      const usable = all.filter((url) => {
        try {
          const host = new URL(url).hostname;
          const loopback =
            host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
          if (loopback) return false;
        } catch {
          return false;
        }
        if (Capacitor.isNativePlatform()) return /^wss:\/\//i.test(url);
        return true;
      });
      // Never hand back an empty list: a loopback-only dev config still needs
      // SOME rendezvous attempt (and the QR shows the user what's wrong).
      return usable.length > 0 ? usable : all;
    },
    // Log out the current user
    async logout(): Promise<void> {
      const login = logins[0];
      if (login) {
        removeLogin(login.id);
        // The removed account's NWC wallet secrets must not outlive it —
        // purgeClientStorage below only runs on the FINAL logout.
        clearWalletStorage(login.pubkey);
        clearEsploraStorage(login.pubkey);
      }
      // Drop the in-memory DM render memo so it can't be read after logout or
      // by the next account. (The persistent decrypt cache is per-pubkey and is
      // wiped by purgeClientStorage on the final logout below.)
      clearRenderedPlaintext();

      // If that was the last identity, wipe all client-side persistence (event
      // cache, drafts, read-state, relay-info, theme, added servers, decrypted
      // images…) and hard-redirect to the landing page so nothing is held onto
      // and the next session boots from clean storage. When other accounts
      // remain, leave their caches intact.
      if (logins.length <= 1) {
        await purgeClientStorage();
        window.location.assign("/welcome");
      }
    },
  };
}
