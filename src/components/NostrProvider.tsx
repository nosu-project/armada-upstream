import React, { useEffect, useMemo, useRef } from "react";
import { NostrEvent, NostrFilter, NPool, NRelay1 } from "@nostrify/nostrify";
import { verifyEvent } from "nostr-tools";
import { NostrContext } from "@nostrify/react";
import { NUser, useNostrLogin } from "@nostrify/react/login";
import type { NostrSigner } from "@nostrify/types";

import { NIndexedDB } from "@nostrify/indexeddb";

import { EventStoreContext } from "@/contexts/EventStoreContext";
import { useAppContext } from "@/hooks/useAppContext";
import { NostrBatcher } from "@/lib/NostrBatcher";
import { normalizeRelayUrl, PLATFORM_RELAYS } from "@/lib/platform";
import { logNostrEvent, logNostrReq } from "@/lib/nostrQueryLog";
import { onStreamKeysAdded, signStreamAuths } from "@/concord-v2/lib/streamAuth";
import { warmRumorStore } from "@/concord-v2/lib/rumorStore";
import { warmInviteInbox } from "@/concord-v2/lib/inviteInbox";

interface NostrProviderProps {
  children: React.ReactNode;
}

/**
 * Per-relay cooldown between signing NEW NIP-42 challenges. A burst of retried
 * REQs (each re-challenged) arrives within milliseconds, so a short window
 * collapses the flood onto one bunker sign while still letting a genuine
 * reconnect re-authenticate quickly. (Challenges are nonces, so we never reuse a
 * signature across challenges — we just refuse the extra ones during the window.)
 */
const AUTH_MIN_INTERVAL_MS = 5_000;

/**
 * NIP-59 gift-wrap kinds (Concord V2 wraps + ephemeral variant). See
 * `wire/ingest.ts` WRAP_KINDS.
 */
const WRAP_KINDS = new Set([1059, 21059]);

/**
 * Skip Schnorr signature verification for gift-wraps, verify everything else.
 *
 * A 1059/21059 wrap's outer signature is cryptographically meaningless to the
 * client: NIP-59 wraps are signed either by a single-use ephemeral key (direct
 * invites) or, in Concord V2, by a group-shared *derived* stream key that every
 * member can sign with. Neither establishes a sender identity. Authenticity and
 * integrity of the payload come from NIP-44 (authenticated encryption) plus the
 * inner seal's signature check (`stream.ts` `verifyEvent(seal)`) and the
 * `rumor.pubkey === seal.pubkey` + rumor-id-hash bindings — all re-checked in
 * the decrypt path regardless of the outer sig. Verifying the wrap here is pure
 * redundant work, and wraps are the highest-volume kind on the auth'd stream
 * relays, so skipping the Schnorr verify for just these kinds is a real ingest
 * win. Every other kind (NIP-29 group events, DMs, profiles, …) still relies on
 * its outer signature for identity, so those keep full verification.
 */
function verifyEventSkippingWraps(event: NostrEvent): boolean {
  if (WRAP_KINDS.has(event.kind)) return true;
  return verifyEvent(event);
}

/**
 * Provides the relay pool for the whole app.
 *
 * Ported from Ditto's NostrProvider:
 * - NIP-42 AUTH: every relay opened through the pool (including targeted
 *   `nostr.relay(url)` handles) signs kind 22242 challenges with the active
 *   login's signer.
 * - Queries are batched (NostrBatcher) and cached in IndexedDB.
 *
 * Routing is Armada-specific: generic pool traffic (kind 0 profiles, kind
 * 10009 lists, anything not group-scoped) goes to the configurable app
 * relays (Ditto-style, default relay.ditto.pub + relay.dreamith.to) plus all
 * configured servers. Group-scoped traffic should use
 * `nostr.relay(serverUrl)` directly so it stays on that server.
 */
const NostrProvider: React.FC<NostrProviderProps> = (props) => {
  const { children } = props;
  const { config } = useAppContext();
  const { logins } = useNostrLogin();

  const pool = useRef<NPool | undefined>(undefined);

  // Shared IndexedDB event cache (batcher writes results into it). Backed by
  // @nostrify/indexeddb (the strfry-port NStore). Its constructor is synchronous
  // — it opens the DB in the background and every method awaits the connection —
  // but the EventStoreContext contract is a Promise, so wrap it. Use a fresh DB
  // name ("armada-events") rather than the legacy "ditto-events": the package
  // installs schema version 1, and pointing it at the old v2 database would make
  // IndexedDB reject the open as a downgrade (→ silent no-op cache).
  const eventStore = useRef<Promise<NIndexedDB> | undefined>(undefined);
  if (eventStore.current === undefined) {
    const db = new NIndexedDB("armada-events");
    // Warm up the IndexedDB connection immediately. The FIRST query after launch
    // pays a one-time cold-connection penalty (~2.5s on Android WebView) before
    // the LevelDB backing is hot; doing a throwaway query now means the first
    // channel open reads a warm store (<100ms) instead of eating that stall.
    void db.query([{ kinds: [0], limit: 1 }]).catch(() => undefined);
    eventStore.current = Promise.resolve(db);
    // Warm the Concord V2 rumor cache's IndexedDB connection too, so the first
    // channel open reads a hot store instead of paying the cold-open penalty.
    warmRumorStore();
    // Same for the V2 direct-invite inbox cache.
    warmInviteInbox();
  }

  // Pool routes: app relays (non-NIP-29 traffic) + all servers
  // (platform-pinned + user-added). The internal servers stay in the set so
  // a fully air-gapped deployment keeps working with zero app relays.
  const poolRelays = useMemo(() => {
    const urls = new Set<string>();
    for (const url of config.appRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    for (const url of PLATFORM_RELAYS) urls.add(url);
    for (const url of config.addedRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config.appRelays, config.addedRelays]);

  const poolRelaysRef = useRef(poolRelays);
  useEffect(() => {
    poolRelaysRef.current = poolRelays;
  }, [poolRelays]);

  // Search relays (NIP-50). `search` filters route here instead of fanning
  // out to every server. Falls back to the pool relays when none configured.
  const searchRelays = useMemo(() => {
    const urls = new Set<string>();
    for (const url of config.searchRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config.searchRelays]);

  const searchRelaysRef = useRef(searchRelays);
  useEffect(() => {
    searchRelaysRef.current = searchRelays;
  }, [searchRelays]);

  // Stable ref to the current user's signer for NIP-42 AUTH. The `open()`
  // callback reads from this ref when a relay sends an AUTH challenge, so it
  // always uses the latest signer without recreating the pool.
  const signerRef = useRef<NostrSigner | undefined>(undefined);
  // Per-relay cache of the most recent signed AUTH event, so a REQ retry that
  // re-triggers the same challenge — or a burst of fresh challenges from a
  // relay that keeps closing our subs — reuses the signature instead of queuing
  // another bunker round-trip.
  const authCacheRef = useRef<Map<string, { challenge: string; event: NostrEvent; signedAt: number }>>(new Map());
  // Per-relay in-flight AUTH sign, so a burst of concurrent challenges for the
  // same relay collapses onto one bunker round-trip instead of N (the cache
  // timestamp is only set AFTER signing, so without this the whole burst slips
  // past the rate-limit check before any of them completes).
  const authInFlightRef = useRef<Map<string, Promise<NostrEvent>>>(new Map());
  // Per-relay cooldown: timestamp until which we refuse to sign a NEW challenge
  // for this relay, so a relay that re-challenges on every retried REQ can't
  // flood the bunker. Set after each successful sign.
  const authCooldownRef = useRef<Map<string, number>>(new Map());

  // Open relay handles + the latest NIP-42 challenge each one issued. Concord
  // V2 authenticates the connection as its DERIVED stream keys (not the user):
  // a kind-1059 REQ at a stream address only passes an auth-gating relay
  // (ditto-relay's default AUTH_KINDS=4,1059) once every `authors` entry — the
  // stream pubkeys — is authenticated on THIS connection. We remember each
  // relay's challenge so newly-registered stream keys (a fresh community join,
  // an added channel, a rekey) can be authenticated on an ALREADY-open socket
  // without waiting for the next auth-required round-trip.
  const openRelaysRef = useRef<Map<string, { relay: NRelay1; challenge?: string }>>(new Map());

  /** Send NIP-42 AUTH frames for the given stream pubkeys on one relay. */
  const sendStreamAuths = (
    entry: { relay: NRelay1; challenge?: string },
    url: string,
    pubkeys?: string[],
  ) => {
    if (!entry.challenge) return;
    const events = signStreamAuths(entry.challenge, url, pubkeys);
    for (const ev of events) {
      try {
        entry.relay.socket.send(JSON.stringify(["AUTH", ev]));
      } catch {
        // socket not open yet / closing — the next auth-required round re-sends.
      }
    }
  };

  /**
   * Reset a relay's NIP-42 state whenever its underlying WebSocket (re)opens
   * (#45): a reconnected socket is a brand-new, UNAUTHENTICATED session, but
   * NRelay1 (through @nostrify/nostrify 0.54.0, see soapbox-pub/nostrify#31)
   * carries the previous session's auth bookkeeping across reconnects —
   * `authRetriedSubs`/`authRetriedEvents` still contain ids that already used
   * their single auth-retry, so an auth-gating relay's first `CLOSED:
   * auth-required` PERMANENTLY deletes the subscription, and `authPromise`
   * may still be the settled promise of the dead session. On top of that, our
   * own per-relay AUTH cooldown could swallow the new connection's one and
   * only challenge during a reconnect storm, and the remembered stream-key
   * challenge is a stale nonce.
   *
   * Clearing all of it on every socket open makes a reconnect behave exactly
   * like a first connection: the fresh challenge signs immediately (no
   * cooldown), gated subs get their auth-retry back, and the stream keys
   * re-authenticate off the NEW challenge when it arrives.
   */
  const watchSocketReopen = (relay: NRelay1, url: string) => {
    const internals = relay as unknown as {
      authRetriedSubs?: Set<string>;
      authRetriedEvents?: Set<string>;
      authPromise?: Promise<void>;
      socket: NRelay1["socket"];
    };
    const onOpen = () => {
      internals.authRetriedSubs?.clear();
      internals.authRetriedEvents?.clear();
      internals.authPromise = undefined;
      authCacheRef.current.delete(url);
      authCooldownRef.current.delete(url);
      authInFlightRef.current.delete(url);
      const entry = openRelaysRef.current.get(url);
      if (entry) entry.challenge = undefined; // the old socket's nonce is dead
    };
    const attach = (socket: NRelay1["socket"]) => {
      try {
        (socket as unknown as {
          addEventListener(type: string, listener: () => void): void;
        }).addEventListener("open", onOpen);
      } catch {
        // No listener support — reconnects fall back to nostrify's behavior.
      }
    };
    // websocket-ts re-emits "open" on every automatic reconnect of the same
    // Websocket instance, but NRelay1.wake() REPLACES `relay.socket` outright
    // after an idle close — intercept the assignment so the replacement socket
    // is watched too.
    let currentSocket = relay.socket;
    attach(currentSocket);
    try {
      Object.defineProperty(relay, "socket", {
        configurable: true,
        enumerable: true,
        get: () => currentSocket,
        set: (socket: NRelay1["socket"]) => {
          currentSocket = socket;
          attach(socket);
        },
      });
    } catch {
      // Non-configurable in some exotic runtime — reconnects of the ORIGINAL
      // socket are still covered by the listener above.
    }
  };


  // The pool MUST be constructed before the signer memo: a bunker (NIP-46)
  // signer is built with `NUser.fromBunkerLogin(login, pool)`, so the pool has
  // to exist first. The `open()` callback only reads the refs lazily (when a
  // relay sends an AUTH challenge), so building it here — before relays/signer
  // are finalized — is safe. (Previously the pool was created AFTER this memo,
  // so a bunker login computed its signer with an `undefined` pool, the memo
  // never recomputed [dep: currentLogin only], and `signerRef` stayed undefined
  // forever — every NIP-42 AUTH then failed with "no signer", which locked an
  // auth-required relay like chat.soapbox.pub into an endless REQ→CLOSED retry
  // and the room received nothing.)
  if (!pool.current) {
    pool.current = new NPool({
      open(url: string) {
        const relay: NRelay1 = new NRelay1(url, {
          // Gift-wrap (1059/21059) outer signatures are redundant on the client
          // (see verifyEventSkippingWraps); skip them, verify everything else.
          verifyEvent: verifyEventSkippingWraps,
          // NIP-42: respond to relay AUTH challenges by signing a kind 22242
          // ephemeral event with the current user's signer.
          //
          // Two safeguards against a slow/remote NIP-46 bunker: (1) reuse a
          // cached signature when the same relay re-issues the same challenge (a
          // REQ retry shouldn't re-sign); (2) serialize all signing through the
          // per-identity signer queue, so concurrent AUTH challenges from many
          // relays don't fan out into parallel bunker round-trips (which the
          // bunker can't service — they all time out, leaving every
          // auth-required relay stuck on CLOSED and the room empty).
          auth: async (challenge: string) => {
            // Remember the challenge so newly-registered Concord V2 stream keys
            // can be authenticated on this same connection later, and
            // authenticate the streams we already hold right now (the stream
            // signatures are local, so they don't wait on the user signer).
            const entry = openRelaysRef.current.get(url) ?? { relay };
            entry.challenge = challenge;
            openRelaysRef.current.set(url, entry);
            sendStreamAuths(entry, url);

            const signer = signerRef.current;
            if (!signer) {
              throw new Error("AUTH failed: no signer available (user not logged in)");
            }
            // NIP-42 challenges are single-use nonces: a signature is only valid
            // for the exact challenge it was made for. So we may ONLY reuse a
            // cached signature when the relay re-issues the IDENTICAL challenge
            // (a plain REQ retry) — never across a fresh challenge, or the relay
            // rejects the stale nonce and re-challenges forever (the room never
            // authenticates).
            const cached = authCacheRef.current.get(url);
            if (cached && cached.challenge === challenge) {
              return cached.event;
            }
            // A fresh challenge must be signed. Two guards keep a relay that
            // re-challenges on every retried REQ from flooding the (slow, remote)
            // bunker: (a) collapse a concurrent burst onto one in-flight sign;
            // (b) rate-limit per relay — within the window, REFUSE the extra
            // challenge (let nostrify retry later) rather than signing it or, worse,
            // returning a stale signature.
            const inFlight = authInFlightRef.current.get(url);
            if (inFlight) return inFlight;
            const cooldownUntil = authCooldownRef.current.get(url) ?? 0;
            if (Date.now() < cooldownUntil) {
              throw new Error(`AUTH throttled for ${url}`);
            }
            const signing = signer.signEvent({
              kind: 22242,
              content: "",
              tags: [
                ["relay", url],
                ["challenge", challenge],
              ],
              created_at: Math.floor(Date.now() / 1000),
            }).then((ev) => {
              authCacheRef.current.set(url, { challenge, event: ev, signedAt: Date.now() });
              authCooldownRef.current.set(url, Date.now() + AUTH_MIN_INTERVAL_MS);
              return ev;
            }).finally(() => {
              authInFlightRef.current.delete(url);
            });
            authInFlightRef.current.set(url, signing);
            return signing;
          },
        });
        const existing = openRelaysRef.current.get(url);
        openRelaysRef.current.set(url, { relay, challenge: existing?.challenge });
        watchSocketReopen(relay, url);
        return relay;
      },
      reqRouter(filters: NostrFilter[]): Map<string, NostrFilter[]> {
        // NIP-50 search: route to dedicated search relays (Ditto pattern),
        // falling back to the pool relays when none are configured.
        if (filters.some((f) => "search" in f)) {
          const targets = searchRelaysRef.current.length > 0
            ? searchRelaysRef.current
            : poolRelaysRef.current;
          const routed = new Map(targets.map((url) => [url, filters]));
          logNostrReq([...routed.keys()], filters, "search");
          return routed;
        }
        const routed = new Map(poolRelaysRef.current.map((url) => [url, filters]));
        logNostrReq([...routed.keys()], filters, "pool");
        return routed;
      },
      eventRouter(event: NostrEvent) {
        const relays = [...poolRelaysRef.current];
        logNostrEvent(relays, event);
        return relays;
      },
      // Resolve queries quickly once any relay sends EOSE.
      eoseTimeout: 300,
    });
  }

  // Now that the pool exists, derive the signer (a bunker signer needs it).
  const currentLogin = logins[0];
  const currentSigner = useMemo(() => {
    if (!currentLogin) return undefined;
    try {
      switch (currentLogin.type) {
        case "nsec":
          return NUser.fromNsecLogin(currentLogin).signer;
        case "bunker":
          return NUser.fromBunkerLogin(currentLogin, pool.current!).signer;
        case "extension":
          return NUser.fromExtensionLogin(currentLogin).signer;
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
    // pool.current is a stable ref (created once above), so it isn't a dep.
  }, [currentLogin]);

  signerRef.current = currentSigner;

  // Wrap the pool in the batching proxy (combines profile/id lookups into single REQs).
  const batcher = useRef<NostrBatcher | undefined>(undefined);
  if (!batcher.current && pool.current) {
    batcher.current = new NostrBatcher(pool.current, eventStore.current);
  }

  useEffect(() => {
    return () => {
      pool.current?.close();
    };
  }, []);

  // When Concord V2 registers new stream keys (a community opens, a channel is
  // added, an epoch rotates), authenticate them on every already-open socket.
  //
  // Auth-gating relays (ditto-relay's default `AUTH_KINDS=4,1059`) authenticate
  // a connection's `authors` ONLY at the single NIP-42 challenge they issue per
  // socket; a stream AUTH replayed on that already-consumed challenge is
  // ignored. So for a socket that has NOT yet been challenged we just send the
  // new stream AUTHs (they'll ride the upcoming first challenge, or the relay
  // challenges on the next gated REQ). But for a socket that ALREADY consumed
  // its challenge, replay is a no-op at the relay — the newly-registered stream
  // stays unauthenticated and its kind-1059 backfill silently returns empty
  // until the process restarts with a fresh socket. To make late registration
  // behave like a restart WITHOUT one, force a reconnect: closing the UNDERLYING
  // browser socket (not the websocket-ts wrapper, whose `close()` sets
  // `closedByUser` and suppresses reconnect) fires a server-style close, so
  // websocket-ts auto-reconnects, `watchSocketReopen` resets the AUTH
  // bookkeeping, and the relay re-challenges — at which point the `auth`
  // callback authenticates the user AND every currently-registered stream key
  // (including the ones that just arrived).
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const reconnectChallengedSockets = () => {
      reconnectTimer = undefined;
      for (const entry of openRelaysRef.current.values()) {
        if (!entry.challenge) {
          // Never challenged yet: the upcoming first challenge will cover the
          // new keys (the `auth` callback signs the whole registry).
          continue;
        }
        // Already authenticated on a spent challenge — replaying AUTH won't add
        // the new authors. Reconnect to earn a fresh challenge that will.
        const underlying = (entry.relay.socket as unknown as {
          _underlyingWebsocket?: { close(code?: number, reason?: string): void };
        })._underlyingWebsocket;
        try {
          // A non-1000 code reads as an abnormal (server-side) close, so
          // websocket-ts reconnects instead of treating it as user-closed.
          underlying?.close(4000, "reauth: new stream keys");
        } catch {
          // No underlying socket / already closing — the fresh connect that
          // follows (or the next gated REQ's challenge) picks up the new keys.
        }
      }
    };
    const unsubscribe = onStreamKeysAdded(() => {
      // Opening a community fires several `registerStreamKeys` calls in quick
      // succession (core keys, per-channel keys, notif-subs). Debounce so the
      // burst collapses into ONE reconnect per socket instead of a thrash.
      if (reconnectTimer === undefined) {
        reconnectTimer = setTimeout(reconnectChallengedSockets, 250);
      }
    });
    return () => {
      unsubscribe();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    };
    // Reads only refs; stable for the provider's lifetime.
  }, []);

  return (
    <NostrContext.Provider value={{ nostr: (batcher.current ?? pool.current) as unknown as NPool }}>
      <EventStoreContext.Provider value={eventStore.current}>
        {children}
      </EventStoreContext.Provider>
    </NostrContext.Provider>
  );
};

export default NostrProvider;
