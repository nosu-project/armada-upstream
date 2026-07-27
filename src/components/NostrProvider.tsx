import React, { useEffect, useMemo, useRef } from "react";
import { NostrEvent, NostrFilter, NPool, NRelay1, NSecSigner } from "@nostrify/nostrify";
import { nip19, verifyEvent } from "nostr-tools";
import { NostrContext } from "@nostrify/react";
import { NUser, useNostrLogin } from "@nostrify/react/login";
import type { NostrSigner } from "@nostrify/types";

import { EventStoreContext, type EventStoreContextType } from "@/contexts/EventStoreContext";
import { userReadRelays, userWriteRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCachedNip29Servers } from "@/hooks/useCachedNip29Servers";
import { appEventStore } from "@/lib/sqlite/eventStore";
import { NostrBatcher } from "@/lib/NostrBatcher";
import { AndroidNativeSigner } from "@/lib/androidNativeSigner";
import { Nip46Signer } from "@/lib/nip46Signer";
import { getNip46Transport } from "@/lib/nip46Transport";
import { normalizeRelayUrl, PLATFORM_RELAYS } from "@/lib/platform";
import { logNostrEvent, logNostrReq } from "@/lib/nostrQueryLog";
import { emitRelayReopened } from "@/lib/relayReopen";
import { logSync } from "@/lib/syncLog";
import {
  noteAuthResult,
  noteRelayChallenged,
  noteStreamAuthSent,
  onStreamAuthStale,
  onStreamKeysAdded,
  resetRelayAuth,
  signStreamAuths,
  signStreamAuthsChunked,
  streamPubkeysForRelay,
} from "@/concord-v2/lib/streamAuth";
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
 * Head start the user signer gets on a NIP-42 challenge before NRelay1's
 * awaited AUTH falls back to a locally-signed stream key. Local/extension
 * signers answer in well under this; only a genuinely slow NIP-46 bunker
 * round-trip exceeds it (and its AUTH is then delivered out-of-band).
 */
const USER_AUTH_HEADSTART_MS = 1_200;

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

  // Shared event cache (batcher writes results into it): the app-wide SQLite
  // store — on Android the native database file the notification service also
  // writes, on web/Electron SQLite-WASM over OPFS, degrading to NIndexedDB
  // where neither is available. See src/lib/sqlite/eventStore.ts.
  const eventStore = useRef<EventStoreContextType | undefined>(undefined);
  if (eventStore.current === undefined) {
    const store = appEventStore();
    // Warm up the connection immediately: the first query after launch pays
    // the backend's one-time cold-open penalty (worker + wasm init, or the
    // ~2.5s Android IndexedDB stall on the fallback); a throwaway query now
    // means the first channel open reads a warm store instead.
    void store.then((s) => s.query([{ kinds: [0], limit: 1 }])).catch(() => undefined);
    eventStore.current = store;
    // Warm the Concord V2 rumor cache's IndexedDB connection too, so the first
    // channel open reads a hot store instead of paying the cold-open penalty.
    warmRumorStore();
    // Same for the V2 direct-invite inbox cache.
    warmInviteInbox();
  }

  // Pool routes: app relays (non-NIP-29 traffic) + all servers
  // (platform-pinned + user-added). The internal servers stay in the set so
  // a fully air-gapped deployment keeps working with zero app relays.
  //
  // The user's servers come from the folded kind 10009 snapshot rather than a
  // config field: this component provides the Nostrify context, so it can't
  // call `useUserGroupList`. The fold needs no relay and no signer, and it
  // re-reads on every snapshot write, so the pool follows adds AND removals.
  const cachedServers = useCachedNip29Servers(logins[0]?.pubkey);

  // The base pool, shared by reads and writes: app relays (unless the user has
  // switched them off) + platform-pinned relays + joined NIP-29 servers. The
  // platform pins and servers are never gated, so an air-gapped deployment
  // keeps working even with app relays off — but a user who empties everything
  // is left with an empty pool, by their own choice.
  const basePoolRelays = useMemo(() => {
    const urls = new Set<string>();
    if (config.useAppRelays) {
      for (const url of config.appRelays) {
        const normalized = normalizeRelayUrl(url);
        if (normalized) urls.add(normalized);
      }
    }
    for (const url of PLATFORM_RELAYS) urls.add(url);
    for (const url of cachedServers) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return urls;
  }, [config.useAppRelays, config.appRelays, cachedServers]);

  // Read (REQ) and write (EVENT) routing sets. Both start from the base pool
  // and, when `useUserRelays` is on, fold in the user's own NIP-65 read/write
  // relays (Ditto's getEffectiveRelays, adapted: app relays are always
  // included, so this only ever ADDS the user's declared relays). With the
  // toggle off the two sets equal the base pool — identical to the previous
  // single-set behavior, so the default path is unchanged.
  const poolReadRelays = useMemo(() => {
    const urls = new Set(basePoolRelays);
    for (const url of userReadRelays(config)) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [basePoolRelays, config]);

  const poolWriteRelays = useMemo(() => {
    const urls = new Set(basePoolRelays);
    for (const url of userWriteRelays(config)) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [basePoolRelays, config]);

  const poolReadRelaysRef = useRef(poolReadRelays);
  useEffect(() => {
    poolReadRelaysRef.current = poolReadRelays;
  }, [poolReadRelays]);

  const poolWriteRelaysRef = useRef(poolWriteRelays);
  useEffect(() => {
    poolWriteRelaysRef.current = poolWriteRelays;
  }, [poolWriteRelays]);

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

  // Per-relay NIP-42 challenge + auth bookkeeping. Concord V2 authenticates
  // as derived stream keys: a kind-1059 REQ passes an auth-gating relay
  // only once every `authors` entry is authenticated on the socket.
  const openRelaysRef = useRef<Map<string, { relay: NRelay1; challenge?: string }>>(new Map());

  /**
   * Send NIP-42 AUTH frames for the stream pubkeys scoped to this relay.
   * Signing is chunked with event-loop yields; aborts if the socket reopens
   * mid-flight (the challenge is then a dead nonce). Each frame is recorded
   * so the relay's `["OK", id, true]` ack marks the key authenticated
   * (streamAuth ack state — plane sweeps gate on it).
   */
  const sendStreamAuths = async (
    entry: { relay: NRelay1; challenge?: string },
    url: string,
    pubkeys?: string[],
  ) => {
    const challenge = entry.challenge;
    if (!challenge) return;
    for await (const chunk of signStreamAuthsChunked(challenge, url, pubkeys)) {
      if (entry.challenge !== challenge) return; // stale nonce — a fresh challenge will re-cover
      for (const ev of chunk) {
        try {
          entry.relay.socket.send(JSON.stringify(["AUTH", ev]));
          // Record as pending ONLY after the frame actually left the socket.
          // A half-open socket (readyState OPEN, TCP dead) throws or silently
          // drops here; marking it pending first would pin the key unacked
          // forever (its OK never comes), wedging streamAuthsSettled until a
          // socket reopen — which a half-open socket never fires. The next
          // auth-required round re-sends.
          noteStreamAuthSent(url, ev.id, ev.pubkey);
        } catch {
          // socket not open yet / closing — the next auth-required round re-sends.
        }
      }
    }
  };

  /**
   * Reset a relay's NIP-42 state on socket reopen (#45): a reconnected socket
   * is a fresh unauthenticated session, but NRelay1 carries stale auth
   * bookkeeping across reconnects. Clearing everything on open makes a
   * reconnect behave like a first connection. Also watches incoming `OK`
   * frames to ack the raw stream AUTHs we send outside NRelay1's own flow.
   *
   * Additionally re-sends NRelay1's PENDING EVENTS on open: NRelay1 re-issues
   * its subscriptions when a socket reconnects but never retransmits an EVENT
   * that is still awaiting its OK. An EVENT written into a half-open socket
   * (backgrounded Android: readyState OPEN, TCP dead) is silently lost, and
   * its `event()` promise burns the full publish timeout — for a NIP-46 login
   * that black-holes the sign request itself, so "send" does nothing for 60s
   * and then fails. Retransmitting on open makes the reconnect lossless
   * (duplicate EVENTs are idempotent — relays dedup by id).
   */
  const watchSocketReopen = (relay: NRelay1, url: string) => {
    const internals = relay as unknown as {
      authRetriedSubs?: Set<string>;
      authRetriedEvents?: Set<string>;
      authPromise?: Promise<void>;
      pendingEvents?: Map<string, NostrEvent>;
      socket: NRelay1["socket"];
    };
    const onOpen = () => {
      internals.authRetriedSubs?.clear();
      internals.authRetriedEvents?.clear();
      internals.authPromise = undefined;
      authCacheRef.current.delete(url);
      authCooldownRef.current.delete(url);
      authInFlightRef.current.delete(url);
      resetRelayAuth(url); // the old session's AUTH acks died with the socket
      const entry = openRelaysRef.current.get(url);
      if (entry) entry.challenge = undefined; // the old socket's nonce is dead
      // Retransmit publishes still awaiting an OK (see docstring). NRelay1
      // removes an event from pendingEvents once its OK arrives, so anything
      // still here either never reached the relay or its OK was lost — both
      // healed by a re-send on the fresh socket.
      const pending = internals.pendingEvents;
      if (pending?.size) {
        logSync("auth", `socket reopened for ${url} — retransmitting ${pending.size} pending EVENT(s)`);
        for (const ev of pending.values()) {
          try {
            relay.socket.send(JSON.stringify(["EVENT", ev]));
          } catch {
            // Socket flapped again — the next reopen retransmits.
          }
        }
      }
      // Tell long-lived consumers (the wire's standing ingestion) that this is
      // a fresh socket session: their re-issued subscriptions may have raced
      // the NIP-42 handshake, so they should re-REQ rather than trust the old
      // round (see relayReopen.ts).
      emitRelayReopened(url);
    };
    // Ack our raw AUTH frames: the relay replies ["OK", <auth event id>, bool].
    // Cheap prefix check first so the wrap firehose isn't double-parsed.
    const onMessage = (...args: unknown[]) => {
      const data = args
        .map((a) => (a as { data?: unknown } | undefined)?.data)
        .find((d): d is string => typeof d === "string");
      if (!data?.startsWith('["OK"')) return;
      try {
        const [, id, ok] = JSON.parse(data) as [string, string, boolean];
        if (typeof id === "string") noteAuthResult(url, id, ok === true);
      } catch {
        // not JSON / not ours
      }
    };
    const attach = (socket: NRelay1["socket"]) => {
      try {
        const s = socket as unknown as {
          addEventListener(type: string, listener: (...args: unknown[]) => void): void;
        };
        s.addEventListener("open", onOpen);
        s.addEventListener("message", onMessage);
      } catch {
        // No listener support — reconnects fall back to nostrify's behavior.
      }
    };
    // websocket-ts re-emits "open" on reconnect, but NRelay1.wake() REPLACES
    // relay.socket — intercept the assignment so the replacement is watched too.
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


  // The pool is constructed before the signer memo below. The `open()`
  // callback only reads the refs lazily (when a relay sends an AUTH
  // challenge), so building it here — before relays/signer are finalized —
  // is safe.
  if (!pool.current) {
    pool.current = new NPool({
      open(url: string) {
        const relay: NRelay1 = new NRelay1(url, {
          // Gift-wrap (1059/21059) outer signatures are redundant on the client
          // (see verifyEventSkippingWraps); skip them, verify everything else.
          verifyEvent: verifyEventSkippingWraps,
          // NIP-42: respond to relay AUTH challenges by signing a kind 22242
          // ephemeral event. The user's signer answers when it's fast (local
          // nsec / extension, or a healthy bunker); a slow NIP-46 bunker is
          // kept off the critical path by falling back to a locally-signed
          // stream key (see the head-start race below).
          auth: async (challenge: string) => {
            // Remember the challenge so newly-registered Concord V2 stream keys
            // can be authenticated on this same connection later, and
            // authenticate the streams we already hold right now (the stream
            // signatures are local, so they don't wait on the user signer).
            const entry = openRelaysRef.current.get(url) ?? { relay };
            entry.challenge = challenge;
            openRelaysRef.current.set(url, entry);
            noteRelayChallenged(url);
            const streamPks = streamPubkeysForRelay(url);
            logSync(
              "auth",
              `NIP-42 challenge from ${url} — signing user + ${streamPks.length} stream key(s)`,
            );
            void sendStreamAuths(entry, url);

            /**
             * Sign the user's kind-22242 for this relay, guarded against a
             * slow/remote NIP-46 bunker: reuse a cached signature when the
             * relay re-issues the IDENTICAL challenge (challenges are
             * single-use nonces, so never across a fresh one); collapse a
             * concurrent burst onto one in-flight sign; and rate-limit per
             * relay — within the window, DELAY the sign until the window ends
             * rather than refusing it (NRelay1's doAuth swallows a rejection
             * and each sub/publish gets ONE auth-retry per socket, so a
             * dropped challenge could kill a gated sub until reconnect). A
             * delayed sign uses the relay's LATEST challenge at fire time.
             */
            const signUserAuth = (): Promise<NostrEvent> => {
              const signer = signerRef.current;
              if (!signer) {
                return Promise.reject(new Error("AUTH failed: no signer available (user not logged in)"));
              }
              const cached = authCacheRef.current.get(url);
              if (cached && cached.challenge === challenge) {
                return Promise.resolve(cached.event);
              }
              const inFlight = authInFlightRef.current.get(url);
              if (inFlight) return inFlight;
              const wait = (authCooldownRef.current.get(url) ?? 0) - Date.now();
              const signing = (wait > 0
                ? new Promise<void>((resolve) => setTimeout(resolve, wait))
                : Promise.resolve()
              ).then(() => {
                const current = openRelaysRef.current.get(url)?.challenge ?? challenge;
                const liveSigner = signerRef.current;
                if (!liveSigner) {
                  throw new Error("AUTH failed: no signer available (user not logged in)");
                }
                return liveSigner.signEvent({
                  kind: 22242,
                  content: "",
                  tags: [
                    ["relay", url],
                    ["challenge", current],
                  ],
                  created_at: Math.floor(Date.now() / 1000),
                }).then((ev) => {
                  authCacheRef.current.set(url, { challenge: current, event: ev, signedAt: Date.now() });
                  authCooldownRef.current.set(url, Date.now() + AUTH_MIN_INTERVAL_MS);
                  return ev;
                });
              }).finally(() => {
                authInFlightRef.current.delete(url);
              });
              authInFlightRef.current.set(url, signing);
              return signing;
            };

            const userSign = signUserAuth();
            userSign.catch(() => undefined); // the stream path below may abandon it
            if (streamPks.length === 0) {
              // No stream keys scoped here (e.g. a NIP-29 relay): the USER
              // identity is what's being authenticated — nothing else can
              // satisfy the gate, so the bunker round-trip is unavoidable.
              return userSign;
            }

            // Keep the bunker OFF the reconnect critical path: NRelay1 holds
            // every auth-retried sub/publish behind this promise, and for a
            // NIP-46 login the sign is a relay round-trip that may itself be
            // traveling over the socket that just reconnected. Give the user
            // sign a short head start; if it hasn't answered, resolve NRelay1
            // with a locally-signed STREAM-key 22242 (~4ms) so gated REQs
            // unblock now, and deliver the user's AUTH out-of-band whenever
            // the bunker responds (ditto-relay accepts AUTH frames for the
            // socket's whole lifetime and its authed set only grows).
            const fast = await Promise.race([
              userSign.then((ev) => ev, () => undefined),
              new Promise<undefined>((r) => setTimeout(() => r(undefined), USER_AUTH_HEADSTART_MS)),
            ]);
            if (fast) return fast;
            void userSign.then((ev) => {
              const live = openRelaysRef.current.get(url);
              try {
                live?.relay.socket.send(JSON.stringify(["AUTH", ev]));
              } catch {
                // Socket flapped — the next challenge re-signs.
              }
            }).catch(() => undefined);
            logSync("auth", `user sign is slow for ${url} — answering the challenge with a stream key, user AUTH to follow`);
            const [streamEv] = signStreamAuths(challenge, url, [streamPks[0]]);
            return streamEv;
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
            : poolReadRelaysRef.current;
          const routed = new Map(targets.map((url) => [url, filters]));
          logNostrReq([...routed.keys()], filters, "search");
          return routed;
        }
        const routed = new Map(poolReadRelaysRef.current.map((url) => [url, filters]));
        logNostrReq([...routed.keys()], filters, "pool");
        return routed;
      },
      eventRouter(event: NostrEvent) {
        const relays = [...poolWriteRelaysRef.current];
        logNostrEvent(relays, event);
        return relays;
      },
      // Resolve queries quickly once any relay sends EOSE.
      eoseTimeout: 300,
    });
  }

  // Derive the NIP-42 AUTH signer for the current login.
  const currentLogin = logins[0];
  const currentSigner = useMemo(() => {
    if (!currentLogin) return undefined;
    try {
      switch (currentLogin.type) {
        case "nsec":
          return NUser.fromNsecLogin(currentLogin).signer;
        case "bunker": {
          // Same DEDICATED plain-WebSocket NIP-46 transport + persistent-sub
          // signer as the user-facing signer (useCurrentUser) — never the
          // relay pool, whose socket machinery wedged remote signs on
          // Android (see nip46Transport.ts / nip46Signer.ts).
          const clientSk = nip19.decode(currentLogin.data.clientNsec) as { type: "nsec"; data: Uint8Array };
          return new Nip46Signer({
            transport: getNip46Transport(
              currentLogin.data.bunkerPubkey,
              currentLogin.data.relays ?? [],
            ),
            bunkerPubkey: currentLogin.data.bunkerPubkey,
            clientSigner: new NSecSigner(clientSk.data),
          });
        }
        case "extension":
          return NUser.fromExtensionLogin(currentLogin).signer;
        case "x-android-signer": {
          // Native Android signer app (Amber, etc.) via NIP-55. Seeded with the
          // login's known pubkey so answering a challenge never triggers a
          // getPublicKey round-trip. NOT wrapped in AppSigner/signerWithNudge —
          // like every other branch here, this is the AUTH-only signer.
          //
          // Each sign is an intent round-trip to the signer app, so it is a
          // "slow signer" in the same sense as a remote bunker: the per-relay
          // cache + in-flight collapse + cooldown above keep a challenge burst
          // down to one round-trip, and the USER_AUTH_HEADSTART_MS race lets a
          // stream key answer the challenge while the user's AUTH follows
          // out-of-band.
          const { packageName } = currentLogin.data as { packageName: string };
          return new AndroidNativeSigner(packageName, currentLogin.pubkey);
        }
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }, [currentLogin]);

  signerRef.current = currentSigner;

  // Wrap the pool in the batching proxy (combines profile/id lookups into single REQs).
  const batcher = useRef<NostrBatcher | undefined>(undefined);
  if (!batcher.current && pool.current) {
    batcher.current = new NostrBatcher(pool.current, eventStore.current);
  }

  useEffect(() => {
    return () => {
      // Closing the pool poisons every captured relay handle (websocket-ts
      // silently drops all sends on a closedByUser socket) — nothing outside
      // this provider may hold a pool reference past unmount.
      pool.current?.close();
    };
  }, []);

  // When Concord V2 registers new stream keys, authenticate them on
  // already-open sockets right away. ditto-relay's challenge stays valid for
  // the socket's lifetime and its authenticated-pubkey set only grows, so a
  // late key just signs the stored challenge and sends another AUTH frame —
  // the relay acks it and subsequent REQs for that author pass. (Verified
  // against the real relay implementation; no socket swap needed.)
  useEffect(() => {
    return onStreamKeysAdded((added) => {
      for (const [url, entry] of openRelaysRef.current) {
        if (!entry.challenge) continue;
        const scoped = new Set(streamPubkeysForRelay(url));
        const pks = added.filter((pk) => scoped.has(pk));
        if (pks.length === 0) continue;
        logSync("auth", `authenticating ${pks.length} late stream key(s) on ${url}`);
        void sendStreamAuths(entry, url, pks);
      }
    });
    // Reads only refs; stable for the provider's lifetime.
  }, []);

  // Self-heal a wedged NIP-42 auth: streamAuthsSettled fires this when a relay
  // was challenged but some stream key stayed unacked past the stale window (a
  // dropped AUTH frame, a lost OK, an ack that raced the listener attach). The
  // old code could only recover via a socket reopen — which a half-open socket
  // never fires — so sync stayed dead until an app restart. Re-sign and re-send
  // the relay's stream AUTHs on the LIVE socket; the relay's challenge is valid
  // for the socket's lifetime, so a fresh AUTH frame still authenticates.
  useEffect(() => {
    return onStreamAuthStale((url) => {
      const entry = openRelaysRef.current.get(url);
      if (!entry?.challenge) return;
      logSync("auth", `stream auth went stale for ${url} — re-sending AUTH frames`);
      void sendStreamAuths(entry, url);
    });
    // Reads only refs; stable for the provider's lifetime.
  }, []);

  // (NIP-46 liveness is handled inside the dedicated transport — see
  // nip46Transport.ts. The pool no longer carries any bunker traffic, so
  // there is nothing to recycle here on resume.)

  return (
    <NostrContext.Provider value={{ nostr: (batcher.current ?? pool.current) as unknown as NPool }}>
      <EventStoreContext.Provider value={eventStore.current}>
        {children}
      </EventStoreContext.Provider>
    </NostrContext.Provider>
  );
};

export default NostrProvider;
