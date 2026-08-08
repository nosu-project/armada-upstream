import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { queryMentionRumors } from "@/concord/lib/rumorStore";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import type { Channel } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";
import { concordMentionReadKey, useReadState } from "@/hooks/useReadState";

/** How many newest cached mentions to surface. */
const MENTION_LIMIT = 200;

/**
 * The current user's mentions across a Concord community — every cached
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
 *
 * Read state is independent of channel read state (issue #53): the tab is a
 * single flat list, so it tracks ONE last-seen `created_at` per community,
 * kept in the shared read-state map at `c2m:<communityIdHex>` — the same map
 * channels and DMs use, so it syncs across devices via the encrypted NIP-78
 * settings event. `hasNew` lights the tab when the newest mention post-dates
 * that stamp; `markAllRead` advances it to the newest mention, so clearing
 * the badge no longer requires opening every mentioning channel. Reading a
 * channel that shows a mention also advances the stamp (see `markRead`).
 */
export function useConcordMentions(channels: Channel[], communityIdHex: string | undefined): {
  mentions: ChatMsg[];
  isLoading: boolean;
  hasNew: boolean;
  markRead: (timestamp: number) => void;
  markAllRead: () => void;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();
  const { readState, markRead: sharedMarkRead } = useReadState();

  // A stable list of channel ids (recomputed only when the set changes), so
  // the query key doesn't churn on every parent re-render.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const { mutedPubkeys } = useMutedPubkeys();

  const { data: allMentions = [], isLoading } = useQuery<ChatMsg[]>({
    ...STORE_READ,
    queryKey: ["concord-mentions", communityIdHex ?? null, pubkey, channelSig],
    queryFn: async ({ signal }) => {
      const rumors = await queryMentionRumors(communityIdHex!, channelIds, pubkey!, {
        limit: MENTION_LIMIT,
        signal,
      });
      // Never surface self-mentions (e.g. quoting yourself). Newest-first.
      return rumors
        .filter((r) => r.author !== pubkey)
        .sort((a, b) => b.ms - a.ms)
        .map(openedToChatMsg);
    },
    enabled: !!communityIdHex && !!pubkey && channelIds.length > 0,
    refetchInterval: 30_000,
    staleTime: 0,
  });

  // Outside the query so a mute takes effect without a re-scan of the store,
  // and so `hasNew` below is derived from the same list the tab renders — a
  // muted mention that still lit the badge would leave a dot the Mentions tab
  // has nothing in it to clear.
  const mentions = useMemo(
    () => (mutedPubkeys.size === 0 ? allMentions : allMentions.filter((m) => !mutedPubkeys.has(m.pubkey))),
    [allMentions, mutedPubkeys],
  );

  // Re-scan the moment the wire ingests a rumor for any watched channel.
  useWireScopes((scopes) => {
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord-mentions", pubkey] });
        return;
      }
    }
  });

  // The mentions last-seen stamp from the shared read-state map (reactive, so
  // the rail badge and the open page re-derive together on any advance).
  const readKey = communityIdHex ? concordMentionReadKey(communityIdHex) : undefined;
  const readAt = readKey ? (readState[readKey] ?? 0) : 0;

  // `created_at` is unix SECONDS on the ChatMsg; the newest mention is first.
  const newestMentionAt = mentions[0]?.created_at ?? 0;
  const hasNew = newestMentionAt > readAt;

  // Advance the stamp to an arbitrary timestamp (monotonic — the shared map
  // no-ops on older stamps). Used when a mention is seen outside the tab,
  // e.g. read naturally in its channel.
  const markRead = useCallback(
    (timestamp: number) => {
      if (!readKey || timestamp <= 0) return;
      sharedMarkRead(readKey, timestamp);
    },
    [readKey, sharedMarkRead],
  );

  const markAllRead = useCallback(() => {
    if (newestMentionAt <= 0) return;
    markRead(newestMentionAt);
  }, [markRead, newestMentionAt]);

  return useMemo(
    () => ({ mentions, isLoading, hasNew, markRead, markAllRead }),
    [mentions, isLoading, hasNew, markRead, markAllRead],
  );
}
