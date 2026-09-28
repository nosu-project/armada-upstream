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
 * Community-wide search over the local decrypted rumor store (Concord chat is
 * E2E encrypted, so there's no relay query). Text is debounced 300ms; results
 * are newest-first and carry their `channel` tag.
 *
 * @param allChannelIds default scope when the filter selects no channels.
 */
export function useConcordSearch(
  community: Community | undefined,
  allChannelIds: string[],
  filters: SearchFilters,
) {
  const communityIdHex = community?.idHex;
  const debouncedQuery = useDebounce(filters.query.trim(), 300);

  const channelIds = filters.channelIds.length > 0 ? filters.channelIds : allChannelIds;

  const effective: SearchFilters = { ...filters, query: debouncedQuery };
  // Activation waits for the debounced query, but deactivation is immediate:
  // stale debounced text after closing search would keep the results pane mounted.
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

  // Search bypasses the timeline, so every drop the fold performs must be repeated
  // here — notably the Banlist: a mod delete never removes the row (NIP-09), and
  // CORD-04 §4 requires dropping every event from a banned npub.
  const { mutedPubkeys } = useMutedPubkeys();
  const moderation = useChatModeration(community);
  // A flood the fold quarantined must not be reachable through search.
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
