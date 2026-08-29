/**
 * In-chat app coordination plane for a NIP-17 DM, scoped to one app session
 * (`uuid`). The DM twin of `useConcordAppSync`, and the same two planes:
 *
 *  - **state** (`sendUpdate`) is a DURABLE kind-3310 rumor carrying an `i` tag
 *    = the session id, gift-wrapped like every other DM rumor. Read back by
 *    {@link queryDm17Webxdc} — its OWN query, not a slice of the thread's page,
 *    because a thread read is one filter with one `limit` and a chatty game
 *    would otherwise evict the conversation from its own window.
 *  - **realtime** (`joinRealtimeChannel`) does NOT ride Nostr at all. Frames go
 *    peer to peer over iroh gossip, the transport Vector uses, so the two
 *    clients share one game rather than two that cannot see each other. The DM
 *    plane carries only the peer signals that let the parties find each other.
 *    Without the transport there is no realtime: a relay fallback would put
 *    half the room on a plane the other half never reads.
 *
 * Peer signals are Vector's DM spelling — a kind-30078 rumor whose CONTENT is
 * the operation and whose tags carry the topic and node address — sealed and
 * wrapped to every participant. They are never stored; the receiving side is
 * `openAndStore` → `dispatchDmPeerSignal` in `useDm17.ts`.
 *
 * Addressed by CONVERSATION, not by a peer: a NIP-17 room is its participant
 * set (`dmConvKey`), and a wrap has to be minted per recipient. Handing a
 * conversation key to a function expecting a pubkey is exactly how the group
 * path used to fail — NIP-44 rejects it, so realtime silently never came up.
 */

import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { effectiveDmRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDmRelaysForAll } from "@/hooks/useDmRelayList";
import {
  DM_WEBXDC_PEER_SCOPE,
  dmWebxdcPeerScope,
  getDmPeerSignals,
  useDm17Thread,
} from "@/hooks/useDm17";
import { queryDm17Webxdc } from "@/lib/nip17/dm17Store";
import { logSync } from "@/lib/syncLog";
import {
  buildDmRumor,
  dmConvPeers,
  KIND_DM_PEER_SIGNAL,
  sealDmRumor,
  wrapDmSeal,
  type Dm17Signer,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import { dmThreadScope } from "@/wire/bus";
import { useWireScopes } from "@/wire/useWireScopes";

import {
  realtimeTransport,
  type RealtimeTransport,
} from "@/lib/realtimeTransport";
import {
  base32Decode,
  decodeNodeAddr,
  dmPeerSignalContent,
  dmPeerSignalTags,
  encodeNodeAddr,
  foldPeerSignals,
  frame,
  isTopicId,
  unframe,
  type PeerSignalEvent,
} from "@/lib/webxdcRealtime";

import type {
  AppStateMeta,
  AppStateUpdate,
  AppSync,
} from "@/hooks/useWebxdcApi";

/** How many dials one session keeps in flight at once. */
const MAX_DIAL_PEERS = 4;

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find(([n]) => n === name)?.[1];
}

/**
 * In-chat app coordination plane for one NIP-17 conversation and one app
 * session. `conversation` is a conversation KEY (see `dmConvKey`).
 *
 * Requires a signed-in user with NIP-44 capability (the DM plane is sealed).
 */
export function useDmAppSync(
  conversation: string | undefined,
  uuid: string,
): AppSync {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const queryClient = useQueryClient();

  const self = user?.pubkey;
  const peers = useMemo(
    () => (conversation ? dmConvPeers(conversation) : []),
    [conversation],
  );
  // Who a wrap actually has to be minted for: everyone but us. Empty for Note
  // to Self, which has no second party to coordinate with.
  const recipients = useMemo(
    () => peers.filter((peer) => peer !== self),
    [peers, self],
  );
  const enabled = Boolean(conversation && uuid && self);

  // Publishing rides the thread's own send path, so the seal/wrap/expiry rules
  // are written once. Its query key is the one the page already mounted, so
  // react-query serves this from cache rather than issuing a second read.
  const { sendWebxdc } = useDm17Thread(conversation);

  const inboxRelays = useDmRelaysForAll(recipients);

  // ── Durable state plane ────────────────────────────────────────────────────

  const stateKey = useMemo(
    () => ["dm17", "app-state", self, conversation, uuid] as const,
    [self, conversation, uuid],
  );
  const { data: opened } = useQuery<OpenedDm[]>({
    queryKey: stateKey,
    enabled,
    // State arrives live off the wire bus (below); this is the slow healing
    // backstop for a missed ring.
    refetchInterval: 60_000,
    queryFn: ({ signal }) => queryDm17Webxdc(self!, peers, uuid, { signal }),
  });

  const stateUpdates = useMemo((): AppStateUpdate[] => {
    return (opened ?? []).map((rumor) => {
      let payload: unknown;
      try {
        payload = JSON.parse(rumor.content);
      } catch {
        payload = rumor.content;
      }
      return {
        payload,
        info: tagValue(rumor.tags, "info"),
        document: tagValue(rumor.tags, "document"),
        summary: tagValue(rumor.tags, "summary"),
      };
    });
  }, [opened]);

  const sendState = useCallback(
    (payload: unknown, opts?: AppStateMeta) => {
      void sendWebxdc(uuid, JSON.stringify(payload), opts)
        .then(() => queryClient.invalidateQueries({ queryKey: stateKey }))
        .catch(() => undefined);
    },
    [sendWebxdc, uuid, queryClient, stateKey],
  );

  // ── Gossip session (realtime plane) ────────────────────────────────────────

  const gossip = useRef<
    { node: RealtimeTransport; topic: Uint8Array; key: Uint8Array } | undefined
  >(undefined);
  const seq = useRef(0);
  const dialledRef = useRef(new Set<string>());
  const sessionClaim = useRef(0);
  const inFlightDials = useRef(0);
  const [meshReady, setMeshReady] = useState(0);

  const sendRealtime = useCallback((data: Uint8Array) => {
    const g = gossip.current;
    // Gossip or nothing. There is no relay path for realtime: a frame that
    // reached only the members who happen to share our transport would make
    // one game look like two, each convinced the other player is idle.
    if (!g) return;
    seq.current += 1;
    // Vector's frame, so its receivers strip the trailer and drop their own
    // echoes exactly as they do for another Vector.
    void g.node
      .send(g.topic, frame(data, seq.current, g.key))
      .catch(() => undefined);
  }, []);

  const listenersRef = useRef(new Set<(data: Uint8Array) => void>());

  // The signals this CONVERSATION has carried for this topic. Scoped to the
  // room, not just the topic: who is playing is a question about a room, and a
  // signal that arrived in one DM must not put its author into a session
  // opened from another.
  const [peerSignals, setPeerSignals] = useState<PeerSignalEvent[]>([]);
  const readPeerSignals = useCallback(() => {
    if (!conversation || !isTopicId(uuid)) return;
    setPeerSignals(getDmPeerSignals(conversation, uuid));
  }, [conversation, uuid]);

  // Whatever arrived while this session was closed is already in hand.
  useEffect(readPeerSignals, [readPeerSignals]);

  useWireScopes((scopes) => {
    if (!conversation || !isTopicId(uuid)) return;
    if (
      scopes.has(dmWebxdcPeerScope(conversation, uuid)) ||
      scopes.has(DM_WEBXDC_PEER_SCOPE)
    ) {
      readPeerSignals();
    }
    // Durable state arrives on the thread's own ring.
    if (scopes.has(dmThreadScope(conversation))) {
      void queryClient.invalidateQueries({ queryKey: stateKey });
    }
  });

  /**
   * Advertise (or retract) our iroh node address to every participant, in
   * Vector's DM shape: a kind-30078 rumor whose content is the operation,
   * sealed and wrapped per recipient like any other DM rumor.
   */
  const sendPeerSignal = useCallback(
    async (topic: string, nodeAddr?: string) => {
      if (!self || !user?.signer.nip44 || recipients.length === 0) return;
      const signer = user.signer as unknown as Dm17Signer;

      const rumor = buildDmRumor({
        kind: KIND_DM_PEER_SIGNAL,
        content: dmPeerSignalContent(nodeAddr),
        // The `p` set is what makes this rumor name its conversation on the
        // other side (`dmPeersOf`), exactly as a message does.
        tags: [
          ...dmPeerSignalTags(topic, nodeAddr),
          ...peers.map((peer) => ["p", peer]),
        ],
        pubkey: self,
      });

      const myRelays = effectiveDmRelays(config);
      await Promise.allSettled(
        recipients.map(async (recipient) => {
          const seal = await sealDmRumor(rumor, recipient, signer);
          const wrap = wrapDmSeal(seal, recipient);
          const targets = [
            ...new Set([...(inboxRelays.get(recipient) ?? []), ...myRelays]),
          ];
          return Promise.allSettled(
            targets.map((url) =>
              nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) }),
            ),
          );
        }),
      );
    },
    [self, user, peers, recipients, config, nostr, inboxRelays],
  );

  // Held in a ref so the join effect can keep its narrow dependency list: it is
  // keyed on the session, and must not tear the mesh down because a relay list
  // resolved.
  const signalRef = useRef(sendPeerSignal);
  signalRef.current = sendPeerSignal;

  /**
   * Bring up the mesh for this app, if the attachment named a topic and the
   * transport is available.
   *
   * The order matters and is Vector's: join first, then advertise. Advertising
   * an address before the topic is subscribed invites a dial that arrives for
   * a topic gossip has not registered, and the frames it carries are dropped.
   */
  useEffect(() => {
    if (!enabled || !isTopicId(uuid) || !conversation) return;
    const topic = base32Decode(uuid);
    if (!topic || topic.length !== 32) return;

    let cancelled = false;
    let node: RealtimeTransport | undefined;
    const claim = ++sessionClaim.current;
    const dialled = dialledRef.current;

    void (async () => {
      node = await realtimeTransport();
      if (!node || cancelled) return;

      const key = Uint8Array.from(
        node
          .publicKeyHex()
          .match(/../g)!
          .map((h) => parseInt(h, 16)),
      );
      await node.join(
        topic,
        [],
        (bytes) => {
          const got = unframe(bytes);
          // Gossip echoes our own broadcasts back; the trailer is how we know.
          if (!got || got.sender === node!.publicKeyHex()) return;
          for (const cb of listenersRef.current) cb(got.payload);
        },
        // A mesh that never formed and one where nobody spoke are the same
        // silence, and only these tell them apart.
        (msg) => logSync("dm", `webxdc gossip: ${msg}`),
      );
      if (cancelled) {
        if (sessionClaim.current === claim) node.leave(topic);
        return;
      }
      gossip.current = { node, topic, key };
      void signalRef.current(uuid, encodeNodeAddr(node.nodeAddrJson()));
      // Announce readiness so the dial pass runs.
      setMeshReady((n) => n + 1);
    })();

    return () => {
      cancelled = true;
      const g = gossip.current;
      gossip.current = undefined;
      if (!g) return;
      // Tell the room before dropping the mesh.
      void signalRef.current(uuid);
      g.node.leave(g.topic);
      dialled.clear();
    };
  }, [enabled, uuid, conversation]);

  /**
   * Dial the peers this conversation has advertised, whenever the signals
   * change or the mesh finishes coming up.
   */
  useEffect(() => {
    const g = gossip.current;
    if (!g || !isTopicId(uuid)) return;
    for (const peer of foldPeerSignals(peerSignals, uuid, self)) {
      if (inFlightDials.current >= MAX_DIAL_PEERS) break;
      if (dialledRef.current.has(peer.addr)) continue;
      dialledRef.current.add(peer.addr);
      const json = decodeNodeAddr(peer.addr);
      if (!json) continue;
      inFlightDials.current += 1;
      void g.node
        .addPeer(g.topic, json)
        .catch(() => dialledRef.current.delete(peer.addr))
        .finally(() => {
          inFlightDials.current -= 1;
        });
    }
  }, [peerSignals, uuid, self, meshReady]);

  const onRealtime = useCallback((cb: (data: Uint8Array) => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return useMemo<AppSync>(
    () => ({ stateUpdates, sendState, sendRealtime, onRealtime }),
    [stateUpdates, sendState, sendRealtime, onRealtime],
  );
}
