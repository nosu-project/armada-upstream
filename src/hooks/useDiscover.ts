import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { nip19 } from "nostr-tools";
import { useEffect, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDebounce } from "@/hooks/useDebounce";
import { useFollowList } from "@/hooks/useFollowList";
import { KIND_EMOJI_SET, emojiPackEntries, emojiPackName } from "@/hooks/useEmojiPacks";
import { resolveBundle } from "@/concord-v2/hooks/useCommunityActions2";
import { parseInviteLink } from "@/concord-v2/lib/invite";
import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementFromEvent,
  type DiscoveredInvite,
} from "@/concord-v2/lib/inviteDiscovery";
import { isNostrId } from "@/lib/nostrId";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { normalizeRelayUrl } from "@/lib/platform";
import { THEME_DEFINITION_KIND, parseDittoTheme } from "@/lib/themeEvent";

import type { NostrFilter } from "@nostrify/nostrify";
import type { FollowListData } from "@/hooks/useFollowList";
import type { NostrRumor } from "@/lib/nostrRumor";

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
 * Warm-load seeds: the last successful follow-pack membership and community
 * list, persisted in KV and pushed into the react-query cache on mount so a
 * returning session paints the Discover grid from local data immediately
 * instead of holding a skeleton for the pack → announcements round trips.
 * Seeds are written into the cache already STALE (`updatedAt: 0`), so the
 * normal network fetch still runs and overwrites them — a seed accelerates
 * first paint, it never suppresses a refresh — and a seed never overwrites
 * data the network already delivered.
 */
const PACK_SEED_KV = "discover:seed:pack";
const COMMUNITIES_SEED_KV = "discover:seed:communities";

/** Push a persisted KV value under a react-query key if nothing is there yet. */
function useKvQuerySeed<T>(kvKey: string, queryKey: QueryKey | undefined): void {
  const queryClient = useQueryClient();
  // Serialize so the effect re-runs when the key changes by value (the
  // announcements key re-keys as the author allow-list resolves).
  const keyString = queryKey ? JSON.stringify(queryKey) : "";
  useEffect(() => {
    if (!keyString) return;
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getArmadaDB().kv.get<T>(kvKey);
        if (cancelled || stored === undefined) return;
        const key = JSON.parse(keyString) as QueryKey;
        if (queryClient.getQueryData(key) !== undefined) return;
        queryClient.setQueryData(key, stored, { updatedAt: 0 });
      } catch {
        // Best-effort: an unreadable seed just means a skeleton first paint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kvKey, keyString, queryClient]);
}

/** Persist a query's latest non-empty result as the next session's seed. */
function writeSeed(kvKey: string, value: unknown[]): void {
  if (value.length === 0) return; // an empty read may be a miss — keep the last good seed
  getArmadaDB().kv.set(kvKey, value).catch(() => undefined);
}

/**
 * The "team soapbox" follow pack (kind 39089). Its members are the seed
 * authorship of every Discover feed: a logged-out visitor sees only their
 * content, and a logged-in user sees it merged with their own follows. Discover
 * is deliberately gated: it is never the unfiltered public firehose by default.
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
function followPackPubkeys(event: NostrRumor | null | undefined): string[] {
  if (!event) return [];
  return event.tags
    .filter(([name]) => name === "p")
    .map(([, pk]) => pk)
    .filter(isNostrId);
}

/** Newest event per addressable coordinate (`kind:pubkey:d`), newest first. */
function newestPerAddr(events: NostrRumor[]): NostrRumor[] {
  const newest = new Map<string, NostrRumor>();
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
  authors: string[] | undefined,
  signal: AbortSignal,
): Promise<NostrRumor[]> {
  // `authors === undefined` means the allow-list is bypassed (the unfiltered
  // firehose). An empty array would be sent as-is, which callers guard against.
  const base: NostrFilter = { kinds: [kind], limit: FETCH_LIMIT };
  if (authors) base.authors = authors;
  const filters: NostrFilter[] = [base];
  // Add a NIP-50 search filter alongside the recent one so search-capable
  // relays surface deeper matches; relays that ignore `search` still answer the
  // plain filter, and the caller filters client-side either way.
  if (query) filters.push({ ...base, search: query });

  const events = await nostr
    .group(relays)
    .query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  return newestPerAddr(events);
}

/** The app relays Discover reads from (de-duplicated). */
export function useDiscoverRelays(): string[] {
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

/** The react-query key of the follow-pack membership read. */
function packQueryKey(relays: string[]): QueryKey {
  return ["discover", "follow-pack", TEAM_FOLLOW_PACK, relays];
}

/** The react-query key of the community-announcements read. */
function communitiesQueryKey(relays: string[], authorFilter: string[] | undefined): QueryKey {
  return ["discover", "community-announcements", relays, authorFilter ?? "all"];
}

/** Fetch the team follow pack's member pubkeys, persisting the warm-load seed. */
async function fetchFollowPack(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  signal: AbortSignal,
): Promise<string[]> {
  const coord = TEAM_PACK_COORD!;
  const [event] = await nostr.group(relays).query(
    [{ kinds: [coord.kind], authors: [coord.pubkey], "#d": [coord.identifier], limit: 1 }],
    { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) },
  );
  const pubkeys = followPackPubkeys(event);
  writeSeed(PACK_SEED_KV, pubkeys);
  return pubkeys;
}

/**
 * Fetch the community announcements (and, in the same round trip, the NIP-09
 * un-publishes that remove listings), persisting the warm-load seed.
 */
async function fetchCommunityAnnouncements(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  authorFilter: string[] | undefined,
  signal: AbortSignal,
): Promise<DiscoveredInvite[]> {
  const filter: NostrFilter = { kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: FETCH_LIMIT };
  if (authorFilter) filter.authors = authorFilter;
  // Honor un-publishes: a NIP-09 delete by the ANNOUNCEMENT'S OWN author
  // removes the listing (anyone else's delete is ignored). Fetched in the
  // SAME round trip as the announcements — un-listing always attaches a
  // `["k", "3314"]` tag (ShareToDiscoverDialog), so the deletes are
  // addressable by kind up front instead of by the announcement ids,
  // which would serialize a second relay hop behind the first.
  const delFilter: NostrFilter = {
    kinds: [5],
    "#k": [String(KIND_COMMUNITY_ANNOUNCEMENT)],
    limit: FETCH_LIMIT,
  };
  if (authorFilter) delFilter.authors = authorFilter;
  const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const [events, dels] = await Promise.all([
    nostr.group(relays).query([filter], { signal: timeout() }),
    nostr.group(relays).query([delFilter], { signal: timeout() }).catch(() => []),
  ]);
  const deleted = new Set<string>();
  const byId = new Map(events.map((e) => [e.id, e.pubkey]));
  for (const del of dels) {
    for (const [n, id] of del.tags) {
      if (n === "e" && byId.get(id) === del.pubkey) deleted.add(id);
    }
  }
  // Newest announcement wins for a given link.
  events.sort((a, b) => b.created_at - a.created_at);
  const byLinkSigner = new Map<string, DiscoveredInvite>();
  for (const event of events) {
    if (deleted.has(event.id)) continue;
    const invite = announcementFromEvent(event);
    if (!invite) continue;
    if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
  }
  const invites = [...byLinkSigner.values()];
  writeSeed(COMMUNITIES_SEED_KV, invites);
  return invites;
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
 * must NOT query when this is empty; see the `enabled` gates below).
 *
 * The `discoverAllContent` setting escape-hatches out of all of this: when on,
 * `unrestricted` is true, callers drop the `authors` filter entirely, and the
 * feeds show the unfiltered firehose (behind an explicit in-settings warning).
 */
export function useDiscoverAuthors(): {
  authors: string[];
  unrestricted: boolean;
  isLoading: boolean;
} {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const relays = useDiscoverRelays();
  const { user } = useCurrentUser();
  const followList = useFollowList();

  const unrestricted = config.discoverAllContent;

  const packKey = packQueryKey(relays);
  // Warm loads: last session's pack membership paints (and un-gates the
  // feeds) immediately; the fetch below still runs and overwrites it.
  useKvQuerySeed<string[]>(PACK_SEED_KV, unrestricted ? undefined : packKey);

  const pack = useQuery<string[]>({
    queryKey: packKey,
    // Skip the pack fetch entirely when the allow-list is bypassed.
    enabled: relays.length > 0 && TEAM_PACK_COORD !== null && !unrestricted,
    staleTime: 60 * 60 * 1000,
    queryFn: ({ signal }) => fetchFollowPack(nostr, relays, signal),
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
    unrestricted,
    // Nothing to wait for when the allow-list is bypassed. Only the PACK read
    // gates the feeds: it is the seed authorship, so querying without it would
    // show a logged-in user a follows-only directory and then re-key. The
    // viewer's own follow list merely WIDENS the list — when it lands later,
    // `authors` changes, the feed queries re-key and refetch, and
    // `placeholderData` holds the pack-authored results meanwhile — so first
    // paint doesn't wait the follow-list round trip out.
    isLoading: unrestricted ? false : pack.isLoading,
  };
}

/**
 * Public Concord communities — kind-3314 community announcements, each a
 * regular event whose content is a full shareable invite link and nothing
 * else. De-duplicated here by link-signer keeping the newest announcement;
 * two DIFFERENT links to one community can only be recognized as duplicates
 * once their bundles resolve, so that fold happens in the Communities tab.
 *
 * No search filter is sent: the announcement deliberately carries no metadata
 * (the card resolves name/icon/banner live from the invite bundle), so there
 * is nothing server-side to match. The Communities tab filters the rendered
 * cards against their RESOLVED names instead.
 */
export function useDiscoverCommunities() {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const { authors, unrestricted, isLoading: authorsLoading } = useDiscoverAuthors();

  const authorFilter = unrestricted ? undefined : authors;

  const communitiesKey = communitiesQueryKey(relays, authorFilter);
  // Warm loads: last session's listings paint immediately, then refresh.
  useKvQuerySeed<DiscoveredInvite[]>(COMMUNITIES_SEED_KV, communitiesKey);

  const result = useQuery<DiscoveredInvite[]>({
    queryKey: communitiesKey,
    enabled: relays.length > 0 && !authorsLoading && (unrestricted || authors.length > 0),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: ({ signal }) => fetchCommunityAnnouncements(nostr, relays, authorFilter, signal),
  });

  // Keep the skeleton up while the author allow-list is still resolving.
  return { ...result, isLoading: result.isLoading || authorsLoading };
}

/** How long after boot the Discover warmup fires (chunk warmup fires at 3s). */
const WARM_DELAY_MS = 3500;
/** How many listings get their invite bundle pre-resolved (about a viewport). */
const WARM_BUNDLE_COUNT = 12;

/**
 * Pre-fetch the Discover data a first navigation needs, shortly after boot and
 * off the critical path: the follow pack, the community announcements, and the
 * first viewport's worth of invite bundles. Everything lands in the shared
 * react-query cache under the SAME keys the page hooks use, and — via the
 * fetchers' KV seeds and the bundle floor — in local storage, so opening
 * Discover paints real cards immediately even in a session (or install) that
 * has never visited it. Best-effort throughout: a failed warmup just means the
 * page fetches for itself, exactly as if this hook didn't exist.
 *
 * The announcements key depends on the author allow-list, which may still be
 * widening (the viewer's follow list) when this runs — a key mismatch with the
 * page's eventual query only costs one extra fetch there, and the KV seed
 * still bridges the paint.
 */
export function useWarmDiscover(): void {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const relays = useDiscoverRelays();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const unrestricted = config.discoverAllContent;
  const pubkey = user?.pubkey;

  useEffect(() => {
    if (relays.length === 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          let authorFilter: string[] | undefined;
          if (!unrestricted) {
            if (TEAM_PACK_COORD === null) return;
            const pack = await queryClient.fetchQuery({
              queryKey: packQueryKey(relays),
              staleTime: 60 * 60 * 1000,
              queryFn: ({ signal }) => fetchFollowPack(nostr, relays, signal),
            });
            const set = new Set(pack);
            if (pubkey) {
              set.add(pubkey);
              // Whatever the follow list holds RIGHT NOW — don't wait on it.
              const follows = queryClient.getQueryData<FollowListData>(["follow-list", pubkey]);
              for (const pk of follows?.pubkeys ?? []) set.add(pk);
            }
            authorFilter = [...set].sort();
            // Fail-closed like the page: no allow-list, no firehose query.
            if (authorFilter.length === 0) return;
          }
          const invites = await queryClient.fetchQuery({
            queryKey: communitiesQueryKey(relays, authorFilter),
            staleTime: 30_000,
            queryFn: ({ signal }) => fetchCommunityAnnouncements(nostr, relays, authorFilter, signal),
          });
          // Resolve the bundles the grid would show first. Sequenced behind
          // the announcements by necessity; each resolve also persists its
          // floor, which is what makes the NEXT session's cards instant.
          await Promise.allSettled(
            invites.slice(0, WARM_BUNDLE_COUNT).map((invite) => {
              const parsed = parseInviteLink(invite.inviteUrl);
              if (!parsed) return Promise.resolve();
              return queryClient.fetchQuery({
                queryKey: ["discover", "invite-bundle", invite.linkSigner],
                staleTime: 5 * 60_000,
                retry: false,
                queryFn: () => resolveBundle(nostr, parsed, parsed.bootstrapRelays),
              });
            }),
          );
        } catch {
          // Warmup is best-effort; the page's own queries remain authoritative.
        }
      })();
    }, WARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [nostr, queryClient, relays, unrestricted, pubkey]);
}

/** NIP-30 emoji packs (kind 30030). */
export function useDiscoverEmojiPacks(query: string) {
  const { nostr } = useNostr();
  const relays = useDiscoverRelays();
  const { authors, unrestricted, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const authorFilter = unrestricted ? undefined : authors;

  const result = useQuery<NostrRumor[]>({
    queryKey: ["discover", "emoji-packs", relays, authorFilter ?? "all", debounced.trim()],
    enabled: relays.length > 0 && !authorsLoading && (unrestricted || authors.length > 0),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, relays, KIND_EMOJI_SET, q, authorFilter, signal);
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
  const { authors, unrestricted, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const authorFilter = unrestricted ? undefined : authors;

  const result = useQuery<NostrRumor[]>({
    queryKey: ["discover", "themes", relays, authorFilter ?? "all", debounced.trim()],
    enabled: relays.length > 0 && !authorsLoading && (unrestricted || authors.length > 0),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, relays, THEME_DEFINITION_KIND, q, authorFilter, signal);
      // Drop anything we can't render as a 3-color theme.
      const usable = events.filter((e) => parseDittoTheme(e) !== null);
      if (!q) return usable;
      const needle = q.toLowerCase();
      return usable.filter((e) => parseDittoTheme(e)?.title.toLowerCase().includes(needle));
    },
  });

  return { ...result, isLoading: result.isLoading || authorsLoading };
}
