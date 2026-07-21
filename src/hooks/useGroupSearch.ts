import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

const KIND_POLL = 1068;
const SEARCH_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

/** Substring match over a message's content (case-insensitive). */
function localMatches(events: NostrEvent[], query: string, limit: number): NostrEvent[] {
  const q = query.toLowerCase();
  return events
    .filter((e) => e.content.toLowerCase().includes(q))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

/**
 * Search messages within a single NIP-29 group. Runs a NIP-50 `search` query
 * scoped to the group (`#h`) on its host relay, and merges in matches from the
 * already-loaded timeline cache so search still works on relays without NIP-50.
 * Results are newest-first.
 */
export function useGroupSearch(
  relayUrl: string | undefined,
  groupId: string | undefined,
  query: string,
  opts?: {
    /** Message kinds to search (default: NIP-29 chat + polls). */
    kinds?: number[];
    /** Cache key of the loaded timeline to merge local matches from. */
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
      // Relay-side NIP-50 search, scoped to this group. Relays without NIP-50
      // ignore the `search` field (returning recent #h events) — harmless,
      // since we re-filter locally below.
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds, "#h": [groupId!], search: debounced, limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );

      // Merge with the locally-cached timeline so already-seen messages are
      // searchable offline / on non-NIP-50 relays.
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
