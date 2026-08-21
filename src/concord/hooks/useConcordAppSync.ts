import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { chatExpiresAt, messageExpirationOf } from "@/concord/lib/disappearing";
import { KIND_SEAL_ENCRYPTED, KIND_WEBXDC } from "@/concord/lib/kinds";
import {
  buildRumor,
  channelBindingTags,
  sealRumor,
  wrapSeal,
} from "@/concord/lib/stream";
import {
  queryWebxdcPeerSignals,
  queryWebxdcRumors,
  writeRumors,
} from "@/concord/lib/rumorStore";
import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import { useWireScopes } from "@/wire/useWireScopes";

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
  peerSignalContent,
  unframe,
} from "@/lib/webxdcRealtime";

import type {
  AppStateMeta,
  AppStateUpdate,
  AppSync,
} from "@/hooks/useWebxdcApi";

/** Least time between peer-signal re-reads driven by chat traffic. */
const PEER_READ_THROTTLE_MS = 5_000;

/** How many dials one session keeps in flight at once. */
const MAX_DIAL_PEERS = 16;

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find(([n]) => n === name)?.[1];
}

/**
 * In-chat app coordination plane for a Concord (E2EE) channel, scoped to one
 * app session (`uuid`). Both planes ride kind {@link KIND_WEBXDC} (3310) rumors
 * sealed under the channel's current stream key and bound to the channel/epoch
 * like every Chat rumor:
 *
 *  - **state** (`sendUpdate`) is a DURABLE 1059 wrap. The wire decrypts every
 *    inner kind into the rumor store, so state arrives there without a
 *    dedicated relay query; 3310 is excluded from {@link CHAT_KINDS} so it
 *    never shows in the timeline. Read back with {@link queryWebxdcRumors},
 *    refreshed live off the wire bus (`c2:<channel>`) plus a slow poll.
 *  - **realtime** (`joinRealtimeChannel`) does NOT ride Nostr at all. Frames
 *    go peer to peer over iroh gossip, the transport Vector uses, so the two
 *    clients share one game rather than two that cannot see each other. The
 *    channel carries only the peer signals that let members find each other.
 *    Without the transport there is no realtime: a relay fallback would put
 *    half the room on a plane the other half never reads.
 *
 * Relays and the AV broker stay blind: every layer is sealed under the channel
 * key. Requires a signed-in member (the seal is signed with the user's real
 * key), which a Concord community membership always is.
 */
export function useConcordAppSync(
  community: Community | undefined,
  channel: Channel | undefined,
  uuid: string,
): AppSync {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // Durable app state is chat-plane data, so it disappears with the rest of
  // the plane (CORD-08 §2); ephemeral frames are never stored and carry nothing.
  const { data: folded } = useControlFold(community);
  const timerSecs = messageExpirationOf(folded?.metadata);

  const enabled = Boolean(community && channel && uuid && user);
  const channelIdHex = channel?.idHex ?? null;
  const queryKey = useMemo(
    () => ["concord", "app-state", channelIdHex, uuid] as const,
    [channelIdHex, uuid],
  );

  // ── Durable state plane ────────────────────────────────────────────────────

  const { data: opened } = useQuery<OpenedChat[]>({
    queryKey,
    enabled,
    // State arrives LIVE via the wire bus (the standing subscription decrypts
    // every channel wrap into the store, which rings `c2:<channel>` on commit
    // and the invalidation below re-reads). This poll is only a slow healing
    // backstop for a missed bus ring.
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const rows = await queryWebxdcRumors(
        community!.idHex,
        channelIdHex!,
        uuid,
        { signal },
      );
      return rows.sort((a, b) => a.ms - b.ms);
    },
  });

  // Peer signals live on the same plane but carry no session tag, so they need
  // their own read; the topic inside the content separates the games.
  const peerKey = useMemo(
    () => ["concord", "webxdc-peers", channelIdHex] as const,
    [channelIdHex],
  );
  const { data: peerRows } = useQuery<OpenedChat[]>({
    queryKey: peerKey,
    enabled: enabled && isTopicId(uuid),
    refetchInterval: 60_000,
    queryFn: async ({ signal }) =>
      queryWebxdcPeerSignals(community!.idHex, channelIdHex!, { signal }),
  });
  const peerSignals = useMemo(
    () =>
      (peerRows ?? []).map((r) => ({
        author: r.author,
        content: r.content,
        ms: r.ms,
      })),
    [peerRows],
  );

  // Re-read when the wire announces new durable rumors for this channel.
  //
  // The peer read is throttled apart from the state read: the wire rings on
  // every chat message, and peer signals are a 2000-row scan with a JSON.parse
  // per row. Joining is not urgent to the second — the incumbent dials the
  // newcomer from their advertisement either way.
  const peerReadAt = useRef(0);
  useWireScopes((scopes) => {
    if (!channelIdHex || !scopes.has(`c2:${channelIdHex}`)) return;
    void queryClient.invalidateQueries({ queryKey });
    const now = Date.now();
    if (now - peerReadAt.current < PEER_READ_THROTTLE_MS) return;
    peerReadAt.current = now;
    void queryClient.invalidateQueries({ queryKey: peerKey });
  });

  const stateUpdates = useMemo((): AppStateUpdate[] => {
    return (opened ?? []).map((m) => {
      let payload: unknown;
      try {
        payload = JSON.parse(m.content);
      } catch {
        payload = m.content;
      }
      return {
        payload,
        info: tagValue(m.tags, "info"),
        document: tagValue(m.tags, "document"),
        summary: tagValue(m.tags, "summary"),
      };
    });
  }, [opened]);

  // ── Publish (both planes share the seal/wrap path) ──────────────────────────

  const publish = useCallback(
    async (content: string, extraTags: string[][]) => {
      if (!community || !channel || !user) return;
      const ms = Date.now();
      const expiresAt = chatExpiresAt(KIND_WEBXDC, ms, timerSecs);
      const rumor = buildRumor({
        kind: KIND_WEBXDC,
        content,
        tags: [
          ...channelBindingTags(channel.idHex, channel.current.epoch),
          ...extraTags,
          ...(expiresAt !== undefined
            ? [["expiration", String(expiresAt)]]
            : []),
        ],
        pubkey: user.pubkey,
        ms,
      });
      const seal = await sealRumor(
        rumor,
        KIND_SEAL_ENCRYPTED,
        channel.current.group,
        user.signer,
      );
      const wrap = wrapSeal(
        seal,
        channel.current.group,
        expiresAt !== undefined ? { expiration: expiresAt } : undefined,
      );
      // Write our own rumor to the store at once (the wire ingests other
      // members'), so the local app sees its own state without a relay round
      // trip.
      writeRumors(community.idHex, [
        {
          rumorId: rumor.id,
          author: user.pubkey,
          kind: KIND_WEBXDC,
          content,
          tags: rumor.tags,
          ms,
          createdAt: rumor.created_at,
          wrapId: wrap.id,
          streamPk: wrap.pubkey,
          sealKind: KIND_SEAL_ENCRYPTED,
          seal,
          channelIdHex: channel.idHex,
          epoch: channel.current.epoch,
        },
      ]);
      await Promise.allSettled(
        community.relays.map((url) =>
          nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) }),
        ),
      );
    },
    [nostr, community, channel, user, timerSecs],
  );

  // The join effect outlives a rekey (it is keyed on the channel, not the
  // epoch), so its departure signal must seal under whatever the current key
  // is rather than the one captured when the game opened.
  //
  // Stamped with its scope, because React runs a dep-change cleanup during the
  // commit of the render that changed the deps — by which point this ref
  // already points at the publisher for the channel we switched TO. Publishing
  // through that would seal the departure into the new channel: the room we
  // actually left never hears it and keeps dialling a node that has gone.
  const publishScope = `${community?.idHex ?? ""}:${channelIdHex ?? ""}`;
  const publishRef = useRef({ scope: publishScope, publish });
  publishRef.current = { scope: publishScope, publish };

  const sendState = useCallback(
    (payload: unknown, opts?: AppStateMeta) => {
      const extraTags: string[][] = [
        ["i", uuid],
        ["alt", "Webxdc update"],
      ];
      if (opts?.info) extraTags.push(["info", opts.info]);
      if (opts?.document) extraTags.push(["document", opts.document]);
      if (opts?.summary) extraTags.push(["summary", opts.summary]);
      void publish(JSON.stringify(payload), extraTags).then(() =>
        queryClient.invalidateQueries({ queryKey }),
      );
    },
    [uuid, publish, queryClient, queryKey],
  );

  // The gossip session for this app, when the transport is available and the
  // attachment carried a topic. Held in a ref because the send path must not
  // re-render the app to learn the mesh came up.
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

  // ── Gossip session (CORD-04 peer signals + iroh transport) ─────────────────

  /**
   * Bring up the mesh for this app, if the attachment named a topic and the
   * transport is available.
   *
   * The order matters and is Vector's: join first, then advertise. Advertising
   * an address before the topic is subscribed invites a dial that arrives for
   * a topic gossip has not registered, and the frames it carries are dropped.
   *
   * The advertisement is a DURABLE 3310 on the channel plane, which is what
   * lets someone opening the game later backfill a recent one instead of
   * waiting for the next re-advertise.
   */
  useEffect(() => {
    if (!enabled || !isTopicId(uuid) || !community || !channel || !selfPubkey)
      return;
    const topic = base32Decode(uuid);
    if (!topic || topic.length !== 32) return;

    let cancelled = false;
    let node: RealtimeTransport | undefined;
    const scope = publishScope;
    // This run's claim on the topic. A join that lands after its effect was
    // torn down must not leave a successor's live session, and a successor
    // must not be torn down by it.
    const claim = ++sessionClaim.current;
    // Captured here rather than read in the cleanup: the ref itself is stable,
    // and the lint rule cannot know that.
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
        // The join SUCCEEDED and nobody owns it: without this the topic stays
        // subscribed, and the next join would adopt it while our callback —
        // belonging to an unmounted hook — keeps receiving the frames. Only
        // when no later run has claimed the topic in the meantime, or this
        // teardown would take the live session with it.
        if (sessionClaim.current === claim) node.leave(topic);
        return;
      }
      gossip.current = { node, topic, key };
      void publishRef.current.publish(peerSignalContent(uuid, encodeNodeAddr(node.nodeAddrJson())), []);
      // Announce readiness so the dial pass runs: the mesh comes up seconds
      // after this effect does, and by then the peers already advertising have
      // long since loaded and will not change again to retrigger it.
      setMeshReady((n) => n + 1);
    })();

    return () => {
      cancelled = true;
      const g = gossip.current;
      gossip.current = undefined;
      if (!g) return;
      // Tell the room before dropping the mesh, or everyone keeps dialling a
      // node that has gone and counts a player who left. Through the publisher
      // for the channel this session belonged to, never the one we moved to.
      if (publishRef.current.scope === scope) {
        void publishRef.current.publish(peerSignalContent(uuid), []);
      }
      g.node.leave(g.topic);
      // Addresses are per-node, so a fresh session must be free to dial a peer
      // this one already reached.
      dialled.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, uuid, community?.idHex, channel?.idHex, selfPubkey]);

  /**
   * Dial the peers the channel has advertised, whenever the signals change or
   * the mesh finishes coming up. `dialledRef` keeps one peer from being dialled
   * twice in a session.
   *
   * Note this is one attempt per address, not a retry loop: the transport
   * dials in a detached task and only the topic bookkeeping is awaited, so a
   * connect that fails never rejects here. Vector retries with backoff; we
   * lean on the peer dialling us back instead, since both sides advertise.
   */
  useEffect(() => {
    const g = gossip.current;
    if (!g || !isTopicId(uuid)) return;
    // Newest first (the fold already sorts). Every member who ever opened this
    // game and closed the tab leaves a durable advertisement behind, so an old
    // channel's fold is mostly ghosts and each one costs a QUIC dial that hangs
    // to its timeout. Bound how many are IN FLIGHT rather than how many are
    // considered: capping candidates would leave a peer still playing forever
    // unreachable behind sixteen ghosts that advertised a minute later.
    const peers = foldPeerSignals(peerSignals, uuid, selfPubkey);
    for (const peer of peers) {
      if (inFlightDials.current >= MAX_DIAL_PEERS) break;
      if (dialledRef.current.has(peer.addr)) continue;
      // Decode BEFORE reserving an in-flight slot. `addr` is sender-controlled
      // and only bounded (not validated) by `parsePeerSignal`, so an undecodable
      // one reaches here; reserving the slot first and bailing on `!json` would
      // leak the counter — sixteen such addresses wedge the dialer for the
      // session, and a channel switch re-encounters them and leaks again.
      // Mark it dialled either way (a bad address never becomes good, so it must
      // not be reconsidered), but only a real dial takes — and releases — a slot.
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
