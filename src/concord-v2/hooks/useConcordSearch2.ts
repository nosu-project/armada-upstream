import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { openedToChatMsg } from "@/concord-v2/hooks/useTransport2";
import { searchChannelRumors } from "@/concord-v2/lib/rumorStore";
import type { ChannelV2 } from "@/concord-v2/lib/types";

import type { ChatMsg } from "@/components/chat/transport";

/**
 * Search a Concord V2 channel's messages by content — LOCAL ONLY. Mirrors
 * NIP-29's {@link useGroupSearch}, minus the relay query: V2 chat is
 * end-to-end encrypted at the channel's stream address, so there is no relay
 * NIP-50 search to fall back on — the decrypted rumor store is the only
 * searchable corpus. Debounced (300ms), activates at ≥2 chars, newest-first.
 */
export function useConcordSearch2(channel: ChannelV2 | undefined, query: string) {
  const debounced = useDebounce(query.trim(), 300);
  const channelIdHex = channel?.idHex;

  const search = useQuery<ChatMsg[]>({
    queryKey: ["concord2", "search", channelIdHex, debounced],
    enabled: Boolean(channelIdHex) && debounced.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const rumors = await searchChannelRumors(channelIdHex!, debounced, { limit: 100, signal });
      return rumors.map(openedToChatMsg);
    },
  });

  const results = useMemo(() => search.data ?? [], [search.data]);

  return {
    results,
    isLoading: search.isFetching && results.length === 0,
    query: debounced,
    active: debounced.length >= 2,
  };
}
