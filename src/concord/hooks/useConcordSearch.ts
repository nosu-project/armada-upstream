import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import { searchRumors } from "@/concord/lib/rumorStore";
import { searchIsActive, type SearchFilters } from "@/concord/lib/search";

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
  communityIdHex: string | undefined,
  allChannelIds: string[],
  filters: SearchFilters,
) {
  const debouncedQuery = useDebounce(filters.query.trim(), 300);

  // Effective scope: the chosen channels, or every channel when none picked.
  const channelIds = filters.channelIds.length > 0 ? filters.channelIds : allChannelIds;

  // Debounce only the text; author/media/channel changes take effect at once.
  const effective: SearchFilters = { ...filters, query: debouncedQuery };
  const active = searchIsActive(effective);

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

  const results = useMemo(() => search.data ?? [], [search.data]);

  return {
    results,
    isLoading: search.isFetching && results.length === 0,
    active,
  };
}
