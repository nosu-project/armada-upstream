import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

const KIND_POLL = 1068;
const SEARCH_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

function localMatches(events: NostrEvent[], query: string, limit: number): NostrEvent[] {
  const q = query.toLowerCase();
  return events
    .filter((e) => e.content.toLowerCase().includes(q))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

/**
 * NIP-50 `search` scoped to the group (`#h`) on its host relay, merged with local timeline
 * matches for relays without NIP-50. Newest-first.
 */
export function useGroupSearch(
  relayUrl: string | undefined,
  groupId: string | undefined,
  query: string,
  opts?: {
    kinds?: number[];
    messagesKey?: readonly unknown[];
  },
) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const debounced = useDebounce(query.trim(), 300);
  const kinds = opts?.kinds ?? SEARCH_KINDS;
  const messagesKey = opts?.messagesKey ?? ["nip29", "messages", relayUrl, groupId];

  const search = useQuery<NostrEvent[]>({
    queryKey: ["nip29", "search", relayUrl, groupId, kinds.join(","), debounced],
    enabled: Boolean(relayUrl && groupId) && debounced.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      // Relays without NIP-50 ignore `search`; we re-filter locally.
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds, "#h": [groupId!], search: debounced, limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      const cached = queryClient.getQueryData<NostrEvent[]>(messagesKey) ?? [];

      const kindSet = new Set(kinds);
      const byId = new Map<string, NostrEvent>();
      for (const e of [...events, ...cached]) {
        if (kindSet.has(e.kind)) byId.set(e.id, e);
      }

      return localMatches([...byId.values()], debounced, 100);
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
