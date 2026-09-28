/**
 * In-chat app coordination for a NIP-17 DM, scoped to one app session (`uuid`).
 * The DM twin of `useConcordAppSync`:
 * - state: durable kind-3310 rumors (`i` tag = session id), read by their own query
 *   {@link queryDm17Webxdc} so a chatty app can't evict the thread window.
 * - realtime: iroh gossip only (Vector's transport); the DM plane carries only peer
 *   signals (kind-30078, never stored). No relay fallback — it would split the room.
 * Addressed by conversation key (`dmConvKey`), not a pubkey; wraps are minted per recipient.
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

const MAX_DIAL_PEERS = 4;

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find(([n]) => n === name)?.[1];
}

/** `conversation` is a conversation KEY (see `dmConvKey`). Requires NIP-44. */
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
  // Everyone but us; empty for Note to Self.
  const recipients = useMemo(
    () => peers.filter((peer) => peer !== self),
    [peers, self],
  );
  const enabled = Boolean(conversation && uuid && self);

  // Reuses the thread's send path; its query key is already mounted, so this hits cache.
  const { sendWebxdc } = useDm17Thread(conversation);

  const inboxRelays = useDmRelaysForAll(recipients);

  const stateKey = useMemo(
    () => ["dm17", "app-state", self, conversation, uuid] as const,
    [self, conversation, uuid],
  );
  const { data: opened } = useQuery<OpenedDm[]>({
    queryKey: stateKey,
    enabled,
    // Live via the wire bus; this is the healing backstop.
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
    // Gossip or nothing: a relay path would make one game look like two.
    if (!g) return;
    seq.current += 1;
    // Vector's frame, so its receivers strip the trailer and drop their own echoes.
    void g.node
      .send(g.topic, frame(data, seq.current, g.key))
      .catch(() => undefined);
  }, []);

  const listenersRef = useRef(new Set<(data: Uint8Array) => void>());

  // Scoped to the conversation, not just the topic.
  const [peerSignals, setPeerSignals] = useState<PeerSignalEvent[]>([]);
  const readPeerSignals = useCallback(() => {
    if (!conversation || !isTopicId(uuid)) return;
    setPeerSignals(getDmPeerSignals(conversation, uuid));
  }, [conversation, uuid]);

  useEffect(readPeerSignals, [readPeerSignals]);

  useWireScopes((scopes) => {
    if (!conversation || !isTopicId(uuid)) return;
    if (
      scopes.has(dmWebxdcPeerScope(conversation, uuid)) ||
      scopes.has(DM_WEBXDC_PEER_SCOPE)
    ) {
      readPeerSignals();
    }
    if (scopes.has(dmThreadScope(conversation))) {
      void queryClient.invalidateQueries({ queryKey: stateKey });
    }
  });

  /** Advertise (or retract) our iroh node address, in Vector's DM shape. */
  const sendPeerSignal = useCallback(
    async (topic: string, nodeAddr?: string) => {
      if (!self || !user?.signer.nip44 || recipients.length === 0) return;
      const signer = user.signer as unknown as Dm17Signer;

      const rumor = buildDmRumor({
        kind: KIND_DM_PEER_SIGNAL,
        content: dmPeerSignalContent(nodeAddr),
        // The `p` set names the conversation on the other side (`dmPeersOf`).
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

  // Ref keeps the join effect keyed on the session only.
  const signalRef = useRef(sendPeerSignal);
  signalRef.current = sendPeerSignal;

  /**
   * Order matters (Vector's): join first, then advertise, or early dials hit an
   * unregistered topic and their frames are dropped.
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
          // Gossip echoes our own broadcasts back; the trailer identifies them.
          if (!got || got.sender === node!.publicKeyHex()) return;
          for (const cb of listenersRef.current) cb(got.payload);
        },
        (msg) => logSync("dm", `webxdc gossip: ${msg}`),
      );
      if (cancelled) {
        if (sessionClaim.current === claim) node.leave(topic);
        return;
      }
      gossip.current = { node, topic, key };
      void signalRef.current(uuid, encodeNodeAddr(node.nodeAddrJson()));
      setMeshReady((n) => n + 1);
    })();

    return () => {
      cancelled = true;
      const g = gossip.current;
      gossip.current = undefined;
      if (!g) return;
      void signalRef.current(uuid);
      g.node.leave(g.topic);
      dialled.clear();
    };
  }, [enabled, uuid, conversation]);

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
