import { useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCommunityRumors } from "@/concord-v2/hooks/useCommunityRumors";
import { openedToChatMsg } from "@/concord-v2/hooks/useTransport2";
import { KIND_MESSAGE, KIND_COMMENT } from "@/concord-v2/lib/kinds";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import type { OpenedChat } from "@/concord-v2/lib/chat";

/** How many newest mentions to surface. */
const MENTION_LIMIT = 200;

/**
 * The current user's mentions across a Concord V2 community — every cached
 * kind-9 message (and kind-1111 thread reply) that p-tags them, from any
 * channel, newest-first. Derived PURELY from the shared community rumor scan
 * ({@link useCommunityRumors}); no store access of its own.
 */
export function useConcord2Mentions(channels: ChannelV2[]): {
  mentions: ChatMsg[];
  isLoading: boolean;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const { byChannel: rumorsByChannel, isLoading } = useCommunityRumors(channelIds);

  const mentions = useMemo<ChatMsg[]>(() => {
    const matched: OpenedChat[] = [];
    for (const rumors of rumorsByChannel.values()) {
      for (const r of rumors) {
        if (r.kind !== KIND_MESSAGE && r.kind !== KIND_COMMENT) continue;
        if (r.author === pubkey) continue; // never surface self-mentions
        if (!r.tags.some(([n, v]) => n === "p" && v === pubkey)) continue;
        matched.push(r);
      }
    }
    // Newest-first, preserving sub-second `ms` ordering before the lossy
    // seconds-granularity ChatMsg mapping.
    matched.sort((a, b) => b.ms - a.ms);
    const capped = matched.length > MENTION_LIMIT ? matched.slice(0, MENTION_LIMIT) : matched;
    return capped.map(openedToChatMsg);
  }, [rumorsByChannel, pubkey]);

  return useMemo(() => ({ mentions, isLoading }), [mentions, isLoading]);
}
