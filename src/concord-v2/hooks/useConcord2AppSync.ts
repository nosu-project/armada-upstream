import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useControlFold2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { chatExpiresAt, messageExpirationOf } from "@/concord-v2/lib/disappearing";
import { KIND_SEAL_ENCRYPTED, KIND_WEBXDC } from "@/concord-v2/lib/kinds";
import { subscribeEphemeral } from "@/concord-v2/lib/ephemeralSub";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  sealRumor,
  wrapSeal,
} from "@/concord-v2/lib/stream";
import { queryWebxdcRumors, writeRumors } from "@/concord-v2/lib/rumorStore";
import type { OpenedChat } from "@/concord-v2/lib/chat";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { useWireScopes } from "@/wire/useWireScopes";

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
 * In-chat app coordination plane for a Concord V2 (E2EE) channel, scoped to one
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
export function useConcord2AppSync(
  community: CommunityV2 | undefined,
  channel: ChannelV2 | undefined,
  uuid: string,
): AppSync {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  // Durable app state is chat-plane data, so it disappears with the rest of
  // the plane (CORD-08 §2); ephemeral frames are never stored and carry nothing.
  const { data: folded } = useControlFold2(community);
  const timerSecs = messageExpirationOf(folded?.metadata);

  const enabled = Boolean(community && channel && uuid && user);
  const channelIdHex = channel?.idHex ?? null;
  const currentPk = channel?.current.group.pk;
  const queryKey = useMemo(
    () => ["concord2", "app-state", channelIdHex, uuid] as const,
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

  // Re-read when the wire announces new durable rumors for this channel.
  useWireScopes((scopes) => {
    if (channelIdHex && scopes.has(`c2:${channelIdHex}`)) {
      void queryClient.invalidateQueries({ queryKey });
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

  const sendRealtime = useCallback(
    (data: Uint8Array) => {
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
