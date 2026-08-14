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

import { AndroidNativeSigner } from "@/lib/androidNativeSigner";
import { useAppContext } from "@/hooks/useAppContext";
import { clearRenderedPlaintext } from "@/hooks/dmRenderCache";
import { Nip46Signer } from "@/lib/nip46Signer";
import { Nip46Transport } from "@/lib/nip46Transport";
import { normalizeRelayUrl } from "@/lib/platform";
import { purgeClientStorage } from "@/lib/purgeClientStorage";
import { signOutAccount } from "@/lib/switchAccount";
import { clearWalletStorage } from "@/lib/walletStorage";
import { clearEsploraStorage } from "@/lib/esploraStorage";
import { logSync } from "@/lib/syncLog";

export type { NostrConnectParams, NostrConnectStatus };
export { generateNostrConnectParams, generateNostrConnectURI } from "@nostrify/react/login";

/** Cap on the frozen bunker relay set — pairing URIs plus the bunker's own. */
const MAX_BUNKER_RELAYS = 8;

/**
 * Whether a relay URL can serve as a NIP-46 rendezvous for THIS client.
 * Loopback is only reachable from this machine, never from a remote signer
 * (a stale ws://localhost:5577 pairing had Amber retry it on every sign for
 * weeks). On a native build (secure WebView origin) non-wss relays are
 * unusable on OUR side (mixed content), so they'd be rendezvous points only
 * the signer could reach — dead weight at best. Non-loopback ws:// LAN
 * relays stay on the web build: an air-gapped LAN deployment with a LAN
 * signer is a supported setup.
 */
function usableRendezvousRelay(url: string): boolean {
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
}

/**
 * Ask a freshly-paired bunker for ITS relay list (the NIP-46 `get_relays`
 * RPC) and merge it into the pairing set. The pairing relays are frozen into
 * the login and are the session's only path to the signer (#48); a shared
 * weeks-old bunker:// URI often carries a partial or stale subset, after
 * which a dead pairing relay means a dead signer forever — even though the
 * signer has long moved to other relays. The bunker's own list is the
 * freshest statement of where it actually listens. Best-effort with a short
 * budget: any failure keeps the pairing relays. Pairing relays stay FIRST
 * (they're proven to reach the signer — it just answered on them).
 */
async function adoptBunkerRelays(signer: Nip46Signer, pairingRelays: string[]): Promise<string[]> {
  let reported: string[];
  try {
    const relays = await Promise.race([
      signer.getRelays(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("get_relays probe timed out")), 10_000),
      ),
    ]);
    reported = Object.entries(relays)
      .filter(([, perm]) => perm?.read || perm?.write)
      .map(([url]) => url);
  } catch {
    return pairingRelays;
  }
  const merged = [...pairingRelays];
  for (const url of reported) {
    const normalized = normalizeRelayUrl(url);
    if (!normalized || !usableRendezvousRelay(normalized) || merged.includes(normalized)) continue;
    merged.push(normalized);
    if (merged.length >= MAX_BUNKER_RELAYS) break;
  }
  logSync("nip46", `session relay set: ${merged.length} relay(s) (${reported.length} reported by bunker)`);
  return merged;
}

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
    // The pairing handshake rides a throwaway Nip46Transport (dedicated plain
    // WebSockets — never the relay pool, whose socket machinery repeatedly
    // wedged NIP-46 traffic on Android; see nip46Transport.ts). Once paired,
    // the bunker's OWN relay list is adopted into the login (see
    // adoptBunkerRelays) and the session signer (useCurrentUser) builds the
    // keyed app-wide transport over the merged set.
    async bunker(uri: string): Promise<void> {
      const { pubkey: bunkerPubkey, secret, relays } = new BunkerURI(uri);
      if (!relays.length) {
        throw new Error("No relay provided");
      }
      const clientSk = generateSecretKey();
      const transport = new Nip46Transport(relays);
      try {
        const signer = new Nip46Signer({
          transport,
          bunkerPubkey,
          clientSigner: new NSecSigner(clientSk),
        });
        await signer.connect(secret);
        const pubkey = await signer.getPublicKey();
        const sessionRelays = await adoptBunkerRelays(signer, relays);
        addAndActivate(
          new NLogin("bunker", pubkey, {
            bunkerPubkey,
            clientNsec: nip19.nsecEncode(clientSk),
            relays: sessionRelays,
          }),
        );
      } finally {
        transport.close();
      }
    },
    // Login with a NIP-07 browser extension
    async extension(): Promise<void> {
      const login = await NLogin.fromExtension();
      addAndActivate(login);
    },
    // Login with a native Android signer app (Amber, etc.) via NIP-55.
    // The plugin round-trips to the signer app to fetch the user's pubkey; we
    // persist it in the login so subsequent sessions don't re-prompt.
    async androidSigner(packageName: string): Promise<void> {
      const signer = new AndroidNativeSigner(packageName);
      const pubkey = await signer.getPublicKey();
      const login = new NLogin("x-android-signer", pubkey, { packageName });
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
          const sessionRelays = await adoptBunkerRelays(signer, params.relays);
          addAndActivate(
            new NLogin("bunker", userPubkey, {
              bunkerPubkey: event.pubkey,
              clientNsec: nip19.nsecEncode(params.clientSecretKey),
              relays: sessionRelays,
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
    // Relay URLs used for NIP-46 nostrconnect communication: the app relays
    // (remote signers are usually reachable through public relays).
    //
    // The user's own NIP-29 servers are deliberately NOT consulted: they live
    // in the kind 10009 list, which can only be read once someone is logged
    // in — and this runs to establish that login.
    //
    // The list is FROZEN into the signer pairing for the lifetime of the
    // session (#48), so relays the signer can never reach must not enter it
    // (see usableRendezvousRelay).
    getRelayUrls(): string[] {
      const appRelays = config.appRelays
        .map(normalizeRelayUrl)
        .filter((url): url is string => Boolean(url));
      const all = [...new Set(appRelays)];
      const usable = all.filter(usableRendezvousRelay);
      // Never hand back an empty list: a loopback-only dev config still needs
      // SOME rendezvous attempt (and the QR shows the user what's wrong).
      return usable.length > 0 ? usable : all;
    },
    // Log out the current user
    async logout(): Promise<void> {
      const login = logins[0];
      if (login) {
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
      // and the next session boots from clean storage.
      if (logins.length <= 1) {
        if (login) removeLogin(login.id);
        await purgeClientStorage();
        window.location.assign("/welcome");
        return;
      }
      // Otherwise another account is about to become active, which is an
      // account SWITCH — so it takes the switch path, reload included, rather
      // than leaving this account's caches for the next one to read. That path
      // persists the remaining logins itself; `removeLogin`'s dispatch would
      // only race it.
      if (login) await signOutAccount(logins, login.id);
    },
  };
}
