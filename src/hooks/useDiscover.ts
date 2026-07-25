import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useDebounce } from "@/hooks/useDebounce";
import { KIND_EMOJI_SET, emojiPackEntries, emojiPackName } from "@/hooks/useEmojiPacks";
import {
  KIND_PUBLIC_COMMUNITY,
  parsePublicListing,
  type PublicListing,
} from "@/concord-v2/lib/publicListing";
import { THEME_DEFINITION_KIND, parseDittoTheme } from "@/lib/themeEvent";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Discover feeds — browse and (NIP-50) search public directory events: opt-in
 * Concord community listings, NIP-30 emoji packs, and shareable themes.
 *
 * Each hook fetches the newest events of its kind, using the NIP-50 `search`
 * field when the user typed a query (so search-capable relays narrow server
 * side). Because many relays don't implement NIP-50 — they simply ignore the
 * `search` field and return recent events — every hook ALSO filters the result
 * client-side by the query, so a typed search stays relevant everywhere. With
 * no query, the tab shows the most recent listings.
 */

const FETCH_LIMIT = 60;
const TIMEOUT_MS = 6000;

/** Newest event per addressable coordinate (`kind:pubkey:d`), newest first. */
function newestPerAddr(events: NostrEvent[]): NostrEvent[] {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    const d = event.tags.find(([n]) => n === "d")?.[1] ?? "";
    const addr = `${event.kind}:${event.pubkey}:${d}`;
    const prev = newest.get(addr);
    if (!prev || event.created_at > prev.created_at) newest.set(addr, event);
  }
  return [...newest.values()].sort((a, b) => b.created_at - a.created_at);
}

/** Shared fetch: newest events of `kind`, NIP-50 `search` applied when present. */
async function fetchDiscover(
  nostr: ReturnType<typeof useNostr>["nostr"],
  kind: number,
  query: string,
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const filter: NostrFilter = { kinds: [kind], limit: FETCH_LIMIT };
  if (query) filter.search = `${query} sort:top`;
  const events = await nostr.query([filter], {
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  return newestPerAddr(events);
}

/** Public Concord community listings (kind 30456). */
export function useDiscoverCommunities(query: string) {
  const { nostr } = useNostr();
  const debounced = useDebounce(query, 300);

  return useQuery<PublicListing[]>({
    queryKey: ["discover", "communities", debounced.trim()],
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, KIND_PUBLIC_COMMUNITY, q, signal);
      const listings = events
        .map(parsePublicListing)
        .filter((l): l is PublicListing => l !== null);
      if (!q) return listings;
      const needle = q.toLowerCase();
      return listings.filter((l) =>
        [l.name, l.description ?? "", l.topics.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      );
    },
  });
}

/** NIP-30 emoji packs (kind 30030). */
export function useDiscoverEmojiPacks(query: string) {
  const { nostr } = useNostr();
  const debounced = useDebounce(query, 300);

  return useQuery<NostrEvent[]>({
    queryKey: ["discover", "emoji-packs", debounced.trim()],
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, KIND_EMOJI_SET, q, signal);
      // Only packs that actually carry emojis are worth showing.
      const usable = events.filter((e) => emojiPackEntries(e).length > 0);
      if (!q) return usable;
      const needle = q.toLowerCase();
      return usable.filter((e) => {
        const shortcodes = emojiPackEntries(e).map((x) => x.shortcode).join(" ");
        return `${emojiPackName(e)} ${shortcodes}`.toLowerCase().includes(needle);
      });
    },
  });
}

/** Shareable theme definitions (Ditto kind 36767). */
export function useDiscoverThemes(query: string) {
  const { nostr } = useNostr();
  const debounced = useDebounce(query, 300);

  return useQuery<NostrEvent[]>({
    queryKey: ["discover", "themes", debounced.trim()],
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, THEME_DEFINITION_KIND, q, signal);
      // Drop anything we can't render as a 3-color theme.
      const usable = events.filter((e) => parseDittoTheme(e) !== null);
      if (!q) return usable;
      const needle = q.toLowerCase();
      return usable.filter((e) => parseDittoTheme(e)?.title.toLowerCase().includes(needle));
    },
  });
}
