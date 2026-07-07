import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { KIND_SEAL_ENCRYPTED, KIND_VOICE_PRESENCE, KIND_WRAP_EPHEMERAL } from "@/concord-v2/lib/kinds";
import {
  buildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  sealRumor,
  wrapSeal,
} from "@/concord-v2/lib/stream";
import {
  fetchAvToken,
  foldVoicePresence,
  parsePresence,
  presenceTags,
  probeAvBroker,
  rendezvousCandidates,
  VOICE_HEARTBEAT_MS,
  VOICE_STALE_MS,
  type AvToken,
  type VoicePresenceEntry,
  type VoicePresenceFold,
} from "@/concord-v2/lib/voice";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { CONCORD_AV_SERVERS } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";

/** The stable empty fold (so idle rows keep constant props). */
const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map() };

/**
 * Live voice presence for one V2 channel (CORD-07 §4): ephemeral kind-23313
 * rumors in 21059 wraps at the channel's current address, sealed under the
 * channel key — relays and brokers never learn who is in a call. Presence is
 * subscription-only (never stored); a `joined` older than 90s counts as
 * absent, so a missed `left` heals by staleness.
 */
export function useVoicePresence2(
  community: CommunityV2 | undefined,
  channel: ChannelV2 | undefined,
): VoicePresenceFold {
  const { nostr } = useNostr();
  const [fold, setFold] = useState<VoicePresenceFold>(EMPTY_FOLD);
  const latest = useRef(new Map<string, VoicePresenceEntry>());

  const channelIdHex = channel?.idHex ?? null;
  const currentPk = channel?.isVoice ? channel.current.group.pk : undefined;

  useEffect(() => {
    latest.current = new Map();
    setFold(EMPTY_FOLD);
    if (!community || !channel || !channelIdHex || !currentPk) return;
    const controller = new AbortController();
    const group = channel.current.group;
    const epoch = channel.current.epoch;

    const recompute = () => {
      const next = foldVoicePresence([...latest.current.values()], Date.now());
      setFold((prev) => {
        if (
          prev.present.length === next.present.length &&
          prev.present.every(
            (p, i) =>
              p.author === next.present[i].author &&
              p.identity === next.present[i].identity &&
              p.broker === next.present[i].broker,
          )
        ) {
          return prev;
        }
        return next;
      });
    };

    const apply = (event: NostrEvent) => {
      try {
        const opened = openWrap(event, group);
        if (opened.kind !== KIND_VOICE_PRESENCE) return;
        checkChannelBinding(opened, channelIdHex, epoch);
        const entry = parsePresence(opened);
        if (!entry) return;
        // Reject far-future stamps so a forged date can't squat "latest".
        if (entry.ms > Date.now() + 60_000) return;
        const prev = latest.current.get(entry.author);
        if (!prev || entry.ms > prev.ms || (entry.ms === prev.ms && entry.rumorId < prev.rumorId)) {
          latest.current.set(entry.author, entry);
        }
        recompute();
      } catch {
        // not ours / malformed
      }
    };

    for (const url of community.relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req(
            [{ kinds: [KIND_WRAP_EPHEMERAL], authors: [currentPk] }],
            { signal: controller.signal },
          )) {
            if (msg[0] === "EVENT") apply(msg[2] as NostrEvent);
          }
        } catch {
          // subscription ended
        }
      })();
    }

    // Staleness decay: three missed heartbeats age a participant out.
    const decay = setInterval(recompute, VOICE_STALE_MS / 6);
    return () => {
      controller.abort();
      clearInterval(decay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, community?.idHex, channelIdHex, currentPk]);

  return fold;
}

/**
 * Announce this member's own call presence (§4): a `joined` (carrying the
 * broker-assigned SFU identity + the broker rendezvous hint) immediately and
 * every 30s while `identity` is set, and a best-effort `left` on teardown — a
 * missed one heals by staleness. Sealed under the channel key like every Chat
 * rumor, with the channel/epoch binding.
 */
export function useVoiceHeartbeat2(
  community: CommunityV2 | undefined,
  channel: ChannelV2 | undefined,
  identity: string | undefined,
  broker: string | undefined,
): void {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  const publish = useCallback(
    async (status: "joined" | "left", id?: string, origin?: string) => {
      if (!user || !community || !channel) return;
      const rumor = buildRumor({
        kind: KIND_VOICE_PRESENCE,
        content: status,
        tags: [...channelBindingTags(channel.idHex, channel.current.epoch), ...presenceTags(status, id, origin)],
        pubkey: user.pubkey,
        ms: Date.now(),
      });
      const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, user.signer);
      const wrap = wrapSeal(seal, channel.current.group, { ephemeral: true });
      await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(6000) })),
      );
    },
    [nostr, user, community, channel],
  );

  useEffect(() => {
    if (!identity || !broker || !user || !community || !channel) return;
    void publish("joined", identity, broker).catch(() => undefined);
    const timer = setInterval(() => {
      void publish("joined", identity, broker).catch(() => undefined);
    }, VOICE_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      void publish("left").catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, broker, user?.pubkey, community?.idHex, channel?.idHex]);
}

/**
 * The §5 rendezvous: resolve the broker to join this channel's call through.
 * If anyone is present, their broker wins (tie-break ordered); an empty room
 * falls back to the deployment's own defaults. Every candidate is probed
 * (`GET /.well-known/concord/av` → 204) and the first reachable one is it.
 */
export function useVoiceBroker2(
  channel: ChannelV2 | undefined,
  fold: VoicePresenceFold,
): { data: string | null | undefined; isLoading: boolean } {
  const roomHex = channel?.voice?.room.pk;
  const candidates = useMemo(
    () => (roomHex ? rendezvousCandidates(roomHex, fold, CONCORD_AV_SERVERS) : []),
    [roomHex, fold],
  );
  const candidatesKey = candidates.join(",");

  return useQuery<string | null>({
    queryKey: ["concord2", "av-broker", channel?.idHex ?? null, candidatesKey],
    enabled: Boolean(channel?.isVoice && roomHex),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      for (const origin of candidates) {
        if (await probeAvBroker(origin, signal)) return origin;
      }
      return null;
    },
  });
}

/**
 * Mint an SFU token from the chosen blind broker (§2). The token embeds the
 * broker-assigned random identity, which keys this member's per-sender frame
 * key and rides their presence — so a refetch would change WHO we are
 * mid-call. Never auto-refetch while mounted.
 */
export function useAvToken2(
  channel: ChannelV2 | undefined,
  broker: string | undefined,
  enabled: boolean,
) {
  return useQuery<AvToken>({
    queryKey: ["concord2", "av-token", channel?.idHex ?? null, channel?.current.epoch.toString(), broker],
    enabled: enabled && Boolean(channel?.voice && broker),
    queryFn: async () => fetchAvToken(broker!, channel!.voice!.room),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}
