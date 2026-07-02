import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { channelPseudonym } from "@/lib/concord/derive";
import { buildInnerEvent, openMessageMulti, sealWithSignedInner } from "@/lib/concord/envelope";
import { KIND_COMMUNITY_TYPING } from "@/lib/concord/kinds";
import type { Channel, Community } from "@/lib/concord/types";

import type { NostrEvent } from "@nostrify/nostrify";

/** How long a typing signal is considered "live" before it ages out. */
const TYPING_WINDOW_MS = 8000;
/** Minimum gap between published typing signals (throttle). */
const TYPING_THROTTLE_MS = 4000;

function readEpochKeys(channel: Channel): Array<{ epoch: bigint; key: Uint8Array }> {
  const keys = channel.epochKeys.length ? channel.epochKeys : [{ epoch: channel.epoch, key: channel.key }];
  return [...keys].sort((a, b) => (a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1 : 0));
}

function channelPseudonyms(channel: Channel): string[] {
  return readEpochKeys(channel).map((ek) => bytesToHex(channelPseudonym(ek.key, channel.id, ek.epoch)));
}

/**
 * Live "who is typing" for a Concord channel, read from sealed kind-3311
 * signals over the channel pseudonym (the relay stays blind). Decrypts under a
 * held epoch key, proves authorship, and folds to the non-stale typers
 * (excluding the current user). Ephemeral — never persisted; ages out on poll.
 */
export function useConcordTyping(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  return useQuery<string[]>({
    queryKey: ["concord", "typing", channel ? bytesToHex(channel.id) : null],
    // Typing is v1-only for now (outside the CORD core rollout's scope).
    enabled: Boolean(community && channel) && community?.proto !== "cord",
    refetchInterval: TYPING_WINDOW_MS / 2,
    staleTime: TYPING_WINDOW_MS / 2,
    queryFn: async ({ signal }) => {
      const epochKeys = readEpochKeys(channel!);
      const zs = channelPseudonyms(channel!);
      const since = Math.floor((Date.now() - TYPING_WINDOW_MS) / 1000);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_COMMUNITY_TYPING], "#z": zs, since, limit: 100 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      const now = Date.now();
      const typers = new Map<string, number>();
      for (const ev of results.flat()) {
        try {
          const opened = openMessageMulti(ev, channel!.id, epochKeys);
          if (opened.kind !== KIND_COMMUNITY_TYPING) continue;
          if (now - opened.ms > TYPING_WINDOW_MS) continue;
          const prev = typers.get(opened.author) ?? 0;
          if (opened.ms > prev) typers.set(opened.author, opened.ms);
        } catch {
          // not ours / invalid
        }
      }
      return [...typers.keys()].filter((pk) => pk !== user?.pubkey);
    },
  });
}

/** A throttled publisher for the current user's typing signal in a channel. */
export function useConcordTypingPublisher(community: Community | undefined, channel: Channel | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const lastSent = useRef(0);

  return useCallback(() => {
    if (!user || !community || !channel) return;
    if (community.proto === "cord") return; // v1-only for now
    const now = Date.now();
    if (now - lastSent.current < TYPING_THROTTLE_MS) return;
    lastSent.current = now;

    void (async () => {
      try {
        const inner = buildInnerEvent({
          channelId: channel.id,
          epoch: channel.epoch,
          kind: KIND_COMMUNITY_TYPING,
          content: "typing",
          ms: now,
        });
        const signed = await user.signer.signEvent(inner);
        const outer = sealWithSignedInner(signed, channel.key, channel.id, channel.epoch);
        await Promise.all(
          community.relays.map((url) =>
            nostr.relay(url).event(outer, { signal: AbortSignal.timeout(6000) }).catch(() => {}),
          ),
        );
      } catch {
        // best-effort; typing is ephemeral
      }
    })();
  }, [nostr, user, community, channel]);
}
