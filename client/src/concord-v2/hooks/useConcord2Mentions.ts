import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { queryMentionRumors } from "@/concord-v2/lib/rumorStore";
import { openedToChatMsg } from "@/concord-v2/hooks/useTransport2";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import { useWireScopes } from "@/wire/useWireScopes";

/** How many newest cached mentions to surface. */
const MENTION_LIMIT = 200;

/**
 * The current user's mentions across a Concord V2 community — every cached
 * kind-9 message (and kind-1111 thread reply) that p-tags them, from ANY of
 * the community's channels, newest-first. Purely local: served from the
 * decrypted rumor cache (IndexedDB), which the wire keeps fed for every
 * channel (no relay query).
 *
 * Deliberately NOT derived from {@link useCommunityRumors} (unlike unread and
 * threads): the shared scan reads only each channel's newest window, so a
 * mention older than a busy channel's window would silently vanish from the
 * tab. Mentions instead use their own single index-backed `#p` filter
 * ({@link queryMentionRumors}) — one cheap transaction reaching the newest
 * `MENTION_LIMIT` mentions across the whole store, however deep. The scan
 * lives in the shared TanStack Query cache (keyed by pubkey + the channel
 * set) and re-runs the moment the wire bus announces a `c2:` change to any
 * watched channel, with a light poll as a backstop. Each row carries its own
 * `channel` binding, so the view can label which channel a mention came from.
 */
export function useConcord2Mentions(channels: ChannelV2[]): {
  mentions: ChatMsg[];
  isLoading: boolean;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();

  // A stable list of channel ids (recomputed only when the set changes), so
  // the query key doesn't churn on every parent re-render.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: mentions = [], isLoading } = useQuery<ChatMsg[]>({
    queryKey: ["concord2-mentions", pubkey, channelSig],
    queryFn: async ({ signal }) => {
      const rumors = await queryMentionRumors(channelIds, pubkey!, { limit: MENTION_LIMIT, signal });
      // Never surface self-mentions (e.g. quoting yourself). Newest-first.
      return rumors
        .filter((r) => r.author !== pubkey)
        .sort((a, b) => b.ms - a.ms)
        .map(openedToChatMsg);
    },
    enabled: !!pubkey && channelIds.length > 0,
    refetchInterval: 30_000,
    staleTime: 0,
  });

  // Re-scan the moment the wire ingests a rumor for any watched channel.
  useWireScopes((scopes) => {
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord2-mentions", pubkey] });
        return;
      }
    }
  });

  return useMemo(() => ({ mentions, isLoading }), [mentions, isLoading]);
}
