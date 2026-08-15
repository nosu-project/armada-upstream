import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { searchRumors } from "@/concord/lib/rumorStore";
import { searchIsActive, type SearchFilters } from "@/concord/lib/search";
import type { Community } from "@/concord/lib/types";

import type { ChatMsg } from "@/components/chat/transport";

/**
 * Community-wide message search over the local decrypted rumor store. Mirrors
 * NIP-29's {@link useGroupSearch}, minus the relay query: Concord chat is
 * end-to-end encrypted, so the rumor store is the only searchable corpus. The
 * structured {@link SearchFilters} (channels / authors / media / text) is
 * translated into an indexed store scan + in-memory predicates. Debounced
 * (300ms on the text), newest-first, cross-channel — each result carries its
 * own `channel` binding tag so callers can group by channel.
 *
 * @param allChannelIds every channel in the community (the default scope when
 *   the filter selects no specific channels).
 */
export function useConcordSearch(
  community: Community | undefined,
  allChannelIds: string[],
  filters: SearchFilters,
) {
  const communityIdHex = community?.idHex;
  const debouncedQuery = useDebounce(filters.query.trim(), 300);

  // Effective scope: the chosen channels, or every channel when none picked.
  const channelIds = filters.channelIds.length > 0 ? filters.channelIds : allChannelIds;

  // Debounce only the text; author/media/channel changes take effect at once.
  const effective: SearchFilters = { ...filters, query: debouncedQuery };
  // Activation waits for the debounced query, but deactivation is immediate.
  // In particular, closing search passes EMPTY_SEARCH_FILTERS while the old
  // debounced text survives for 300ms; treating that stale text as active keeps
  // the results pane mounted and the message timeline absent during a jump.
  const active = searchIsActive(filters) && searchIsActive(effective);

  const channelsKey = [...channelIds].sort().join(",");
  const authorsKey = [...filters.authors].sort().join(",");

  const search = useQuery<ChatMsg[]>({
    queryKey: [
      "concord",
      "search",
      communityIdHex ?? null,
      channelsKey,
      authorsKey,
      filters.media,
      debouncedQuery,
    ],
    enabled: !!communityIdHex && active && channelIds.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const rumors = await searchRumors(communityIdHex!, channelIds, {
        query: debouncedQuery,
        authors: filters.authors,
        media: filters.media,
        limit: 100,
        signal,
      });
      return rumors.map(openedToChatMsg);
    },
  });

  // Search reads the store directly rather than the timeline, so every drop the
  // fold performs has to be repeated here or search becomes the way around it.
  //
  // The Banlist is the sharp one. A moderator's delete never removes the row —
  // the store refuses a kind-5 whose author isn't the target (NIP-09), so it is
  // dropped in the fold and nowhere else — which means an abusive message whose
  // author was deleted and banned was still sitting in `c2:<communityId>`,
  // verbatim and findable by every member, indefinitely. CORD-04 §4 is explicit
  // that every honest client drops every event from a banned npub.
  const { mutedPubkeys } = useMutedPubkeys();
  const moderation = useChatModeration(community);
  // Re-derive when the persisted quarantine warms or grows, as the mentions tab
  // does: a flood the fold quarantined must not be reachable through search.
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);
  const channelsSig = channelIds.join(",");
  const results = useMemo(() => {
    void memoryRev;
    let list = search.data ?? [];
    if (mutedPubkeys.size > 0) list = list.filter((m) => !mutedPubkeys.has(m.pubkey));
    if (moderation.banned.size > 0) list = list.filter((m) => !moderation.banned.has(m.pubkey));
    if (communityIdHex) {
      let quarantined: Set<string> | undefined;
      for (const idHex of channelIds) {
        const remembered = recallQuarantined(communityIdHex, idHex);
        if (!remembered) continue;
        quarantined ??= new Set();
        for (const id of remembered) quarantined.add(id);
      }
      if (quarantined && quarantined.size > 0) list = list.filter((m) => !quarantined.has(m.id));
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.data, mutedPubkeys, moderation, communityIdHex, channelsSig, memoryRev]);

  return {
    results,
    isLoading: search.isFetching && results.length === 0,
    active,
  };
}
