import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { nip19 } from "nostr-tools";
import { useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDebounce } from "@/hooks/useDebounce";
import { useFollowList } from "@/hooks/useFollowList";
import { KIND_EMOJI_SET, emojiPackEntries, emojiPackName } from "@/hooks/useEmojiPacks";
import {
  SHARE_MARKER,
  invitesFromEvent,
  type DiscoveredInvite,
} from "@/concord-v2/lib/inviteDiscovery";
import { isNostrId } from "@/lib/nostrId";
import { normalizeRelayUrl } from "@/lib/platform";
import { THEME_DEFINITION_KIND, parseDittoTheme } from "@/lib/themeEvent";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Discover feeds — browse and search public directory events: opt-in Concord
 * community listings, NIP-30 emoji packs, and shareable themes.
 *
 * Queries the app relays directly (`config.appRelays` — the same general-purpose
 * relays everything non-group uses) via `nostr.group(...)`. Going direct
 * bypasses the pool's `search`-filter router (which would otherwise divert a
 * search to the dedicated search relays only). When the user typed a query we
 * send BOTH a NIP-50 `search` filter (search-capable relays narrow server-side)
 * AND a plain recent filter, then filter client-side — so results still appear
 * on relays that don't implement NIP-50. With no query the tab shows the most
 * recent events.
 */

const FETCH_LIMIT = 100;
const TIMEOUT_MS = 6000;

/**
 * The "team soapbox" follow pack (kind 39089). Its members are the seed
 * authorship of every Discover feed: a logged-out visitor sees only their
 * content, and a logged-in user sees it merged with their own follows. Discover
 * is deliberately gated — it is never the unfiltered public firehose.
 */
const TEAM_FOLLOW_PACK =
  "naddr1qvzqqqyckypzpyexz3t34l966ngh5xg7u2q788hthdqmj0av3lv8s2tz9t43zt6dqqxxkdrsx4mnqm3jxfeh2ess5pyrw";

/** The decoded follow-pack coordinate (`null` if the naddr ever fails to parse). */
const TEAM_PACK_COORD = ((): { kind: number; pubkey: string; identifier: string } | null => {
  try {
    const decoded = nip19.decode(TEAM_FOLLOW_PACK);
    if (decoded.type !== "naddr") return null;
    const { kind, pubkey, identifier } = decoded.data;
    return { kind, pubkey, identifier };
  } catch {
    return null;
  }
})();

/** Valid (hex) member pubkeys from a follow pack's `p` tags. */
function followPackPubkeys(event: NostrEvent | null | undefined): string[] {
  if (!event) return [];
  return event.tags
    .filter(([name]) => name === "p")
    .map(([, pk]) => pk)
    .filter(isNostrId);
}

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

/** Shared fetch across the app relays. */
async function fetchDiscover(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  kind: number,
  query: string,
  authors: string[],
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const filters: NostrFilter[] = [{ kinds: [kind], authors, limit: FETCH_LIMIT }];
  // Add a NIP-50 search filter alongside the recent one so search-capable
  // relays surface deeper matches; relays that ignore `search` still answer the
  // plain filter, and the caller filters client-side either way.
  if (query) filters.push({ kinds: [kind], authors, search: query, limit: FETCH_LIMIT });

  const events = await nostr
    .group(relays)
    .query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  return newestPerAddr(events);
}

/** The app relays Discover reads from (de-duplicated). */
function useDiscoverRelays(): string[] {
  const { config } = useAppContext();
  return useMemo(() => {
    const urls = new Set<string>();
    for (const url of config.appRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
    return [...urls];
  }, [config.appRelays]);
}

/**
 * The author allow-list that gates every Discover feed.
 *
 * - Logged out: the members of the team-soapbox follow pack (its `p` tags).
 * - Logged in: those members merged with the viewer's own follows (kind 3) and
 *   the viewer themselves.
 *
 * Fail-closed: if the pack can't be read and the viewer has no follows, the
 * list is empty and the feeds show nothing rather than the public firehose (an
 * empty `authors` filter is treated by some relays as "no filter", so callers
 * must NOT query when this is empty — see the `enabled` gates below).
 */
export function useDiscoverAuthors(): { authors: string[]; isLoading: boolean } {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const { user } = useCurrentUser();
  const followList = useFollowList();

  const pack = useQuery<string[]>({
    queryKey: ["discover", "follow-pack", TEAM_FOLLOW_PACK, relays],
    enabled: relays.length > 0 && TEAM_PACK_COORD !== null,
    staleTime: 60 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const coord = TEAM_PACK_COORD!;
      const [event] = await nostr.group(relays).query(
        [{ kinds: [coord.kind], authors: [coord.pubkey], "#d": [coord.identifier], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) },
      );
      return followPackPubkeys(event);
    },
  });

  const authors = useMemo(() => {
    const set = new Set<string>(pack.data ?? []);
    if (user) {
      set.add(user.pubkey);
      for (const pk of followList.data?.pubkeys ?? []) set.add(pk);
    }
    // Sorted for a stable react-query key across renders.
    return [...set].sort();
  }, [pack.data, user, followList.data]);

  return {
    authors,
    isLoading: pack.isLoading || (!!user && followList.isLoading),
  };
}

/**
 * Public Concord communities — mined from ordinary notes that share a full
 * invite link. NIP-50-searches notes for the invite-URL marker (ANDed with the
 * user's query), extracts the links, and de-duplicates by link-signer keeping
 * the newest sharing note.
 */
export function useDiscoverCommunities(query: string) {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const { authors, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const result = useQuery<DiscoveredInvite[]>({
    queryKey: ["discover", "communities", relays, authors, debounced.trim()],
    enabled: relays.length > 0 && !authorsLoading && authors.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const search = q ? `${q} ${SHARE_MARKER}` : SHARE_MARKER;
      const events = await nostr.group(relays).query(
        [{ kinds: [1], authors, search, limit: FETCH_LIMIT }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) },
      );
      // Newest note wins for a given link.
      events.sort((a, b) => b.created_at - a.created_at);
      const byLinkSigner = new Map<string, DiscoveredInvite>();
      for (const event of events) {
        for (const invite of invitesFromEvent(event)) {
          if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
        }
      }
      return [...byLinkSigner.values()];
    },
  });

  // Keep the skeleton up while the author allow-list is still resolving.
  return { ...result, isLoading: result.isLoading || authorsLoading };
}

/** NIP-30 emoji packs (kind 30030). */
export function useDiscoverEmojiPacks(query: string) {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const { authors, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const result = useQuery<NostrEvent[]>({
    queryKey: ["discover", "emoji-packs", relays, authors, debounced.trim()],
    enabled: relays.length > 0 && !authorsLoading && authors.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, relays, KIND_EMOJI_SET, q, authors, signal);
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

  return { ...result, isLoading: result.isLoading || authorsLoading };
}

/** Shareable theme definitions (Ditto kind 36767). */
export function useDiscoverThemes(query: string) {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const { authors, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const result = useQuery<NostrEvent[]>({
    queryKey: ["discover", "themes", relays, authors, debounced.trim()],
    enabled: relays.length > 0 && !authorsLoading && authors.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, relays, THEME_DEFINITION_KIND, q, authors, signal);
      // Drop anything we can't render as a 3-color theme.
      const usable = events.filter((e) => parseDittoTheme(e) !== null);
      if (!q) return usable;
      const needle = q.toLowerCase();
      return usable.filter((e) => parseDittoTheme(e)?.title.toLowerCase().includes(needle));
    },
  });

  return { ...result, isLoading: result.isLoading || authorsLoading };
}
