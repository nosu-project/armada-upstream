import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { chatExpiresAt, messageExpirationOf } from "@/concord/lib/disappearing";
import { KIND_SEAL_ENCRYPTED, KIND_WEBXDC } from "@/concord/lib/kinds";
import { subscribeEphemeral } from "@/concord/lib/ephemeralSub";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  sealRumor,
  wrapSeal,
} from "@/concord/lib/stream";
import { queryWebxdcPeerSignals, queryWebxdcRumors, writeRumors } from "@/concord/lib/rumorStore";
import type { OpenedChat } from "@/concord/lib/chat";
import type { Channel, Community } from "@/concord/lib/types";
import { useWireScopes } from "@/wire/useWireScopes";

import { realtimeTransport, type RealtimeTransport } from "@/lib/realtimeTransport";
import {
  base32Decode,
  foldPeerSignals,
  frame,
  isTopicId,
  peerSignalContent,
  unframe,
} from "@/lib/webxdcRealtime";

import type { AppStateMeta, AppStateUpdate, AppSync } from "@/hooks/useWebxdcApi";
import type { NostrEvent } from "@nostrify/nostrify";

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find(([n]) => n === name)?.[1];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
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
 *  - **realtime** (`joinRealtimeChannel`) is an EPHEMERAL 21059 wrap carrying an
 *    `["rt","1"]` marker — relays never store it, so (exactly like typing and
 *    voice presence) it is delivered by a session-scoped `req()` at the
 *    channel's current address, never through the store.
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
  const currentPk = channel?.current.group.pk;
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
      const rows = await queryWebxdcRumors(community!.idHex, channelIdHex!, uuid, { signal });
      return rows.sort((a, b) => a.ms - b.ms);
    },
  });

  // Peer signals live on the same plane but carry no session tag, so they need
  // their own read; the topic inside the content separates the games.
  const peerKey = useMemo(() => ["concord", "webxdc-peers", channelIdHex] as const, [channelIdHex]);
  const { data: peerRows } = useQuery<OpenedChat[]>({
    queryKey: peerKey,
    enabled: enabled && isTopicId(uuid),
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => queryWebxdcPeerSignals(community!.idHex, channelIdHex!, { signal }),
  });
  const peerSignals = useMemo(
    () => (peerRows ?? []).map((r) => ({ author: r.author, content: r.content, ms: r.ms })),
    [peerRows],
  );

  // Re-read when the wire announces new durable rumors for this channel.
  useWireScopes((scopes) => {
    if (channelIdHex && scopes.has(`c2:${channelIdHex}`)) {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: peerKey });
    }
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
    async (content: string, extraTags: string[][], ephemeral: boolean) => {
      if (!community || !channel || !user) return;
      const ms = Date.now();
      const expiresAt = ephemeral ? undefined : chatExpiresAt(KIND_WEBXDC, ms, timerSecs);
      const rumor = buildRumor({
        kind: KIND_WEBXDC,
        content,
        tags: [
          ...channelBindingTags(channel.idHex, channel.current.epoch),
          ...extraTags,
          ...(expiresAt !== undefined ? [["expiration", String(expiresAt)]] : []),
        ],
        pubkey: user.pubkey,
        ms,
      });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      const wrap = wrapSeal(
        seal,
        channel.current.group,
        ephemeral ? { ephemeral: true } : expiresAt !== undefined ? { expiration: expiresAt } : undefined,
      );
      // Durable state: write our own update to the store immediately (the wire
      // ingests other members'), so the local app sees its own move without a
      // relay round-trip. Ephemeral frames are never stored.
      if (!ephemeral) {
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
      }
      await Promise.allSettled(
        community.relays.map((url) =>
          nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) }),
        ),
      );
    },
    [nostr, community, channel, user, timerSecs],
  );

  const sendState = useCallback(
    (payload: unknown, opts?: AppStateMeta) => {
      const extraTags: string[][] = [["i", uuid], ["alt", "Webxdc update"]];
      if (opts?.info) extraTags.push(["info", opts.info]);
      if (opts?.document) extraTags.push(["document", opts.document]);
      if (opts?.summary) extraTags.push(["summary", opts.summary]);
      void publish(JSON.stringify(payload), extraTags, false).then(() =>
        queryClient.invalidateQueries({ queryKey }),
      );
    },
    [uuid, publish, queryClient, queryKey],
  );

  // The gossip session for this app, when the transport is available and the
  // attachment carried a topic. Held in a ref because the send path must not
  // re-render the app to learn the mesh came up.
  const gossip = useRef<{ node: RealtimeTransport; topic: Uint8Array; key: Uint8Array } | undefined>(undefined);
  const seq = useRef(0);

  const sendRealtime = useCallback(
    (data: Uint8Array) => {
      const g = gossip.current;
      if (g) {
        seq.current += 1;
        // Vector's frame, so its receivers can strip it and drop their own
        // echoes exactly as they do for another Vector.
        void g.node.send(g.topic, frame(data, seq.current, g.key)).catch(() => {
          // A dead mesh must not silently swallow moves; the relay plane still
          // reaches anyone who never joined gossip.
          void publish(bytesToBase64(data), [["i", uuid], ["rt", "1"], ["alt", "Webxdc realtime"]], true);
        });
        return;
      }
      void publish(bytesToBase64(data), [["i", uuid], ["rt", "1"], ["alt", "Webxdc realtime"]], true);
    },
    [uuid, publish],
  );

  // ── Realtime plane (ephemeral, subscription-only) ───────────────────────────

  const listenersRef = useRef(new Set<(data: Uint8Array) => void>());
  const selfPubkey = user?.pubkey;

  useEffect(() => {
    if (!enabled || !community || !channel || !channelIdHex || !currentPk) return;
    const group = channel.current.group;
    const epoch = channel.current.epoch;

    const apply = (event: NostrEvent) => {
      try {
        const ev = openWrap(event, group);
        if (ev.kind !== KIND_WEBXDC) return;
        checkChannelBinding(ev, channelIdHex, epoch);
        if (tagValue(ev.tags, "i") !== uuid) return;
        if (tagValue(ev.tags, "rt") !== "1") return;
        // Skip our own echoes — realtime is for OTHER participants.
        if (ev.author === selfPubkey) return;
        const bytes = base64ToBytes(ev.content);
        for (const cb of listenersRef.current) cb(bytes);
      } catch {
        // not ours / malformed
      }
    };

    // One shared 21059 REQ per relay across every mounted channel — see
    // `ephemeralSub.ts`.
    const unsubs = community.relays.map((url) => subscribeEphemeral(nostr, url, currentPk, apply));
    return () => {
      for (const unsub of unsubs) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nostr, community?.idHex, channelIdHex, currentPk, uuid, selfPubkey]);

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
    if (!enabled || !isTopicId(uuid) || !community || !channel || !selfPubkey) return;
    const topic = base32Decode(uuid);
    if (!topic || topic.length !== 32) return;

    let cancelled = false;
    let node: RealtimeTransport | undefined;
    const dialled = new Set<string>();

    void (async () => {
      node = await realtimeTransport();
      if (!node || cancelled) return;

      const key = Uint8Array.from(node.publicKeyHex().match(/../g)!.map((h) => parseInt(h, 16)));
      await node.join(topic, [], (bytes) => {
        const got = unframe(bytes);
        // Gossip echoes our own broadcasts back; the trailer is how we know.
        if (!got || got.sender === node!.publicKeyHex()) return;
        for (const cb of listenersRef.current) cb(got.payload);
      });
      if (cancelled) return;
      gossip.current = { node, topic, key };
      void publish(peerSignalContent(uuid, node.nodeAddrJson()), [], false);
    })();

    return () => {
      cancelled = true;
      const g = gossip.current;
      gossip.current = undefined;
      if (!g) return;
      // Tell the room before dropping the mesh, or everyone keeps dialling a
      // node that has gone and counts a player who left.
      void publish(peerSignalContent(uuid), [], false);
      g.node.leave(g.topic);
      dialled.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, uuid, community?.idHex, channel?.idHex, selfPubkey]);

  /**
   * Dial the peers the channel has advertised. Vector re-advertises, so this
   * re-runs as signals land; `dialled` keeps a peer from being dialled twice
   * for one session.
   */
  const dialledRef = useRef(new Set<string>());
  useEffect(() => {
    const g = gossip.current;
    if (!g || !isTopicId(uuid)) return;
    const peers = foldPeerSignals(peerSignals, uuid, selfPubkey);
    for (const peer of peers) {
      if (dialledRef.current.has(peer.addr)) continue;
      dialledRef.current.add(peer.addr);
      const json = new TextDecoder().decode(base32Decode(peer.addr) ?? new Uint8Array());
      if (!json) continue;
      void g.node.addPeer(g.topic, json).catch(() => dialledRef.current.delete(peer.addr));
    }
  }, [peerSignals, uuid, selfPubkey]);

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
