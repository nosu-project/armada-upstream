/**
 * In-chat app coordination plane for NIP-17 DMs, scoped to one app session
 * (`uuid`). This is the DM twin of `useConcordAppSync`:
 *
 *  - **state** (`sendUpdate`) rides kind 15 file messages with an `i` tag
 *    (the webxdc uuid). Durable state is read from the DM thread's file
 *    messages filtered by the session id.
 *  - **realtime** (`joinRealtimeChannel`) does NOT ride Nostr at all. Frames
 *    go peer to peer over iroh gossip, the transport Vector uses, so the two
 *    clients share one game rather than two that cannot see each other. The
 *    DM plane carries only the peer signals that let the two parties find
 *    each other.
 *
 * Peer signals are kind 30078 rumors (Vector's `vector-webxdc-peer` d tag)
 * gift-wrapped to the DM peer, exactly as Vector sends them. The receiving
 * side is in `useDm17.ts` (openAndStore → dispatchDmPeerSignal).
 */

import { useNostr } from "@nostrify/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDm17Thread, getDmPeerSignals, dmWebxdcPeerScope } from "@/hooks/useDm17";
import { useWireScopes } from "@/wire/useWireScopes";
import {
  buildDmRumor,
  KIND_DM_FILE,
  KIND_DM_PEER_SIGNAL,
  sealDmRumor,
  wrapDmSeal,
  type Dm17Signer,
} from "@/lib/nip17/protocol";
import { effectiveDmRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useDmRelaysForAll } from "@/hooks/useDmRelayList";

import {
  realtimeTransport,
  type RealtimeTransport,
} from "@/lib/realtimeTransport";
import {
  base32Decode,
  decodeNodeAddr,
  encodeNodeAddr,
  foldPeerSignals,
  frame,
  isTopicId,
  unframe,
  dmPeerSignalTags,
  dmPeerSignalContent,
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
 * In-chat app coordination plane for a NIP-17 DM, scoped to one app session
 * (`uuid`). Both planes ride the DM's gift-wrap envelope:
 *
 *  - **state** (`sendUpdate`) is a DURABLE kind 15 file message with an `i`
 *    tag = the session uuid. Read back from the DM thread, refreshed live
 *    off the wire bus plus a slow poll.
 *  - **realtime** (`joinRealtimeChannel`) does NOT ride Nostr at all. Frames
 *    go peer to peer over iroh gossip, the transport Vector uses, so the two
 *    clients share one game rather than two that cannot see each other. The
 *    DM plane carries only the peer signals that let the two parties find
 *    each other. Without the transport there is no realtime: a relay fallback
 *    would put half the room on a plane the other half never reads.
 *
 * Requires a signed-in user with NIP-44 capability (the DM plane is sealed).
 */
export function useDmAppSync(
  peer: string | undefined,
  uuid: string,
): AppSync {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();

  const self = user?.pubkey;
  const enabled = Boolean(peer && uuid && user);

  // The DM conversation key for this peer
  const conversation = peer;

  // Get the DM thread for durable state
  const dmThread = useDm17Thread(conversation);

  // Get the peer's inbox relays (must be called at top level, not in callbacks)
  const inboxRelays = useDmRelaysForAll(peer ? [peer] : []);

  // ── Durable state plane ────────────────────────────────────────────────────

  // State updates are kind 14 or 15 messages with an `i` tag matching our uuid.
  // Kind 14 is for lightweight updates (like scores), kind 15 for files.
  // We read them from the DM thread's messages.
  const stateUpdates = useMemo((): AppStateUpdate[] => {
    if (!dmThread.messages.length) return [];
    const updates: AppStateUpdate[] = [];
    for (const msg of dmThread.messages) {
      // Accept both kind 14 (chat/webxdc updates) and kind 15 (file)
      if (msg.kind !== KIND_DM_FILE && msg.kind !== 14) continue;
      const sessionTag = tagValue(msg.tags, "i");
      if (sessionTag !== uuid) continue;
      // The content is the JSON payload
      let payload: unknown;
      try {
        payload = JSON.parse(msg.content);
      } catch {
        payload = msg.content;
      }
      updates.push({
        payload,
        info: tagValue(msg.tags, "info"),
        document: tagValue(msg.tags, "document"),
        summary: tagValue(msg.tags, "summary"),
      });
    }
    return updates;
  }, [dmThread.messages, uuid]);

  // ── Publish (state plane) ──────────────────────────────────────────────────

  const sendState = useCallback(
    (payload: unknown, opts?: AppStateMeta) => {
      if (!peer || !self || !user?.signer.nip44) return;
      // Send as a kind 15 file message with the session uuid in the `i` tag.
      // The content is the JSON payload.
      const tags: string[][] = [
        ["i", uuid],
        ["alt", "Webxdc update"],
      ];
      if (opts?.info) tags.push(["info", opts.info]);
      if (opts?.document) tags.push(["document", opts.document]);
      if (opts?.summary) tags.push(["summary", opts.summary]);
      // Use the DM thread's sendFile-like mechanism via send
      // For now, we use the thread's send with the content as JSON
      void dmThread.send(JSON.stringify(payload), tags).catch(() => {});
    },
    [peer, self, user, uuid, dmThread],
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
  const selfPubkey = user?.pubkey;

  // Peer signals from the DM plane (received via useDm17's openAndStore)
  const [peerSignals, setPeerSignals] = useState<Array<{ author: string; content: string; ms: number }>>([]);

  // Subscribe to peer signal updates via wire bus
  useWireScopes((scopes) => {
    if (!uuid || !isTopicId(uuid)) return;
    if (scopes.has(dmWebxdcPeerScope(uuid)) || scopes.has("dm:webxdc-peer")) {
      const signals = getDmPeerSignals(uuid);
      setPeerSignals(signals.map((s) => ({
        author: s.author,
        content: s.op === "ad"
          ? JSON.stringify({ op: "ad", topic: s.topic, addr: s.addr })
          : JSON.stringify({ op: "left", topic: s.topic }),
        ms: s.ms,
      })));
    }
  });

  /**
   * Send a peer signal to the DM peer via gift-wrapped kind 30078.
   * This matches Vector's `send_webxdc_peer_advertisement` format.
   */
  const sendPeerSignal = useCallback(
    async (topic: string, nodeAddr?: string) => {
      if (!peer || !self || !user?.signer.nip44) return;
      const signer = user.signer as unknown as Dm17Signer;

      // Build the peer signal rumor (kind 30078)
      const content = dmPeerSignalContent(nodeAddr);
      const tags = dmPeerSignalTags(topic, nodeAddr);
      // Add the receiver's pubkey as a p tag (Vector's format)
      tags.push(["p", peer]);

      const rumor = buildDmRumor({
        kind: KIND_DM_PEER_SIGNAL,
        content,
        tags,
        pubkey: self,
      });

      // Seal and wrap to the peer
      const seal = await sealDmRumor(rumor, peer, signer);
      const wrap = wrapDmSeal(seal, peer);

      // Publish to our DM relays and the peer's inbox relays
      const myRelays = effectiveDmRelays(config);
      const peerInboxRelays = inboxRelays.get(peer) ?? [];
      const targets = [...new Set([...myRelays, ...peerInboxRelays])];

      await Promise.allSettled(
        targets.map((url) =>
          nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) }),
        ),
      );
    },
    [peer, self, user, config, nostr, inboxRelays],
  );

  /**
   * Bring up the mesh for this app, if the attachment named a topic and the
   * transport is available.
   *
   * The order matters and is Vector's: join first, then advertise. Advertising
   * an address before the topic is subscribed invites a dial that arrives for
   * a topic gossip has not registered, and the frames it carries are dropped.
   */
  useEffect(() => {
    if (!enabled || !isTopicId(uuid) || !peer || !selfPubkey) return;
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
        (msg) => console.debug("[webxdc] gossip:", msg),
      );
      if (cancelled) {
        if (sessionClaim.current === claim) node.leave(topic);
        return;
      }
      gossip.current = { node, topic, key };
      // Advertise our node address to the peer
      void sendPeerSignal(uuid, encodeNodeAddr(node.nodeAddrJson()));
      // Announce readiness so the dial pass runs
      setMeshReady((n) => n + 1);
    })();

    return () => {
      cancelled = true;
      const g = gossip.current;
      gossip.current = undefined;
      if (!g) return;
      // Tell the peer before dropping the mesh
      void sendPeerSignal(uuid);
      g.node.leave(g.topic);
      dialled.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, uuid, peer, selfPubkey]);

  /**
   * Dial the peers the DM plane has advertised, whenever the signals change or
   * the mesh finishes coming up.
   */
  useEffect(() => {
    const g = gossip.current;
    if (!g || !isTopicId(uuid)) return;
    const peers = foldPeerSignals(peerSignals, uuid, selfPubkey);
    for (const peerSignal of peers) {
      if (inFlightDials.current >= MAX_DIAL_PEERS) break;
      if (dialledRef.current.has(peerSignal.addr)) continue;
      dialledRef.current.add(peerSignal.addr);
      const json = decodeNodeAddr(peerSignal.addr);
      if (!json) continue;
      inFlightDials.current += 1;
      void g.node
        .addPeer(g.topic, json)
        .catch(() => dialledRef.current.delete(peerSignal.addr))
        .finally(() => {
          inFlightDials.current -= 1;
        });
    }
  }, [peerSignals, uuid, selfPubkey, meshReady]);

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