import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelPseudonym } from "@/lib/concord/derive";
import { openMessageMulti, type OpenedMessage } from "@/lib/concord/envelope";
import { KIND_COMMUNITY_PRESENCE } from "@/lib/concord/kinds";
import {
  buildVoicePresenceInner,
  foldVoicePresence,
  rendezvousBroker,
  sealVoicePresence,
  voiceCapabilityUrl,
  VOICE_PRESENCE_HEARTBEAT_MS,
  type VoicePresenceEntry,
} from "@/lib/concord/voice";
import { getPreferredConcordVoiceServer } from "@/lib/voiceDevices";
import type { Channel, Community } from "@/lib/concord/types";

import { bytesToHex } from "@noble/hashes/utils.js";
import type { NostrEvent } from "@nostrify/nostrify";

/** The held epoch keys for a channel: every retained epoch, newest first. */
function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

/** The `#z` pseudonyms to query for a channel's presence (one per held epoch). */
function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/**
 * Live "who is in voice" presence for a Concord channel, read from sealed
 * kind-3306 announcements over the channel pseudonym (the relay stays blind).
 * Decrypts each under a held epoch key, proves authorship, and folds to the
 * non-stale `joined` participants (each carrying the broker it joined through —
 * the rendezvous hint). Polled on the heartbeat interval so stale presences age
 * out.
 */
export function useConcordVoicePresence(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();

  return useQuery<VoicePresenceEntry[]>({
    queryKey: ["concord", "voice-presence", channel ? bytesToHex(channel.id) : null],
    enabled: Boolean(community && channel),
    // Refetch a little faster than the stale window so departures clear promptly.
    refetchInterval: VOICE_PRESENCE_HEARTBEAT_MS,
    staleTime: VOICE_PRESENCE_HEARTBEAT_MS,
    queryFn: async ({ signal }) => {
      const epochKeys = readEpochKeys(channel!);
      const zs = channelPseudonyms(channel!);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_COMMUNITY_PRESENCE], "#z": zs, limit: 200 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      const opened: OpenedMessage[] = [];
      for (const ev of results.flat()) {
        try {
          opened.push(openMessageMulti(ev, channel!.id, epochKeys));
        } catch {
          // not ours / invalid → skip
        }
      }
      return foldVoicePresence(opened, Date.now());
    },
  });
}

/**
 * Resolve which voice server (blind LiveKit broker) to join a channel through,
 * and confirm it answers. The rule, in order:
 *
 *   1. If anyone is already in voice, use THEIR broker (the rendezvous hint),
 *      deterministically tiebroken — so members on different armada hosts
 *      converge on one room with no community-level config.
 *   2. Otherwise (empty room), use the user's own client-preferred server.
 *
 * Returns the chosen broker origin (probed live), or null if it isn't reachable.
 * Voice servers are a CLIENT setting + a live presence hint; the community
 * stores nothing about them.
 */
export function useConcordVoiceServer(community: Community | undefined, channel: Channel | undefined) {
  const { data: presence } = useConcordVoicePresence(community, channel);
  // Prefer the broker people are already on; else our own client preference.
  const candidate = rendezvousBroker(presence ?? []) ?? getPreferredConcordVoiceServer();

  return useQuery<string | null>({
    queryKey: ["concord", "voice-server", candidate],
    queryFn: async ({ signal }) => {
      if (!candidate) return null;
      try {
        const res = await fetch(voiceCapabilityUrl(candidate), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (res.status === 204 || res.ok) return candidate;
      } catch {
        // unreachable
      }
      return null;
    },
    enabled: Boolean(candidate),
    staleTime: 60 * 1000,
  });
}

/**
 * Publish a voice-presence heartbeat while the local user is in a Concord call.
 * Call `useConcordVoiceHeartbeat(community, channel, broker)` from the connected
 * room: while `broker` is set, it seals a kind-3306 `joined` (carrying the
 * broker, so others converge there) immediately and every heartbeat interval;
 * on stop/unmount it publishes a `left`. The inner is signed by the user's real
 * key (authorship), sealed under the channel key.
 */
export function useConcordVoiceHeartbeat(
  community: Community | undefined,
  channel: Channel | undefined,
  broker: string | undefined,
) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  const publish = useCallback(
    async (status: "joined" | "left") => {
      if (!user || !community || !channel) return;
      const innerTemplate = buildVoicePresenceInner(channel, status, broker);
      const signedInner = await user.signer.signEvent(innerTemplate);
      const outer = sealVoicePresence(channel, signedInner);
      await Promise.all(
        community.relays.map((url) =>
          nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {}),
        ),
      );
    },
    [nostr, user, community, channel, broker],
  );

  useEffect(() => {
    if (!broker || !user || !community || !channel) return;
    let stopped = false;
    void publish("joined");
    const timer = setInterval(() => {
      if (!stopped) void publish("joined");
    }, VOICE_PRESENCE_HEARTBEAT_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      // Best-effort departure announcement so others clear us promptly.
      void publish("left");
    };
  }, [broker, user, community, channel, publish]);
}
