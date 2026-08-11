import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { nip19 } from "nostr-tools";
import { useEffect, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDebounce } from "@/hooks/useDebounce";
import { useFollowList } from "@/hooks/useFollowList";
import { KIND_EMOJI_SET, emojiPackEntries, emojiPackName } from "@/hooks/useEmojiPacks";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { resolveBundle } from "@/concord/hooks/useCommunityActions";
import { parseInviteLink } from "@/concord/lib/invite";
import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementFromEvent,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
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
const DIRECTORY_SEED_KV = "discover:seed:directory";

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
  let pubkeys = followPackPubkeys(event);
  if (pubkeys.length === 0) {
    // An empty read on a cold pool or a dropped REQ is a probable miss, not
    // an empty pack — and an empty pack collapses the allow-list, blanking
    // feeds that had already painted. Carry the last good membership forward
    // (writeSeed's fail-open rule, same as fetchDiscoverDirectory's).
    const seeded = await getArmadaDB()
      .kv.get<string[]>(PACK_SEED_KV)
      .catch(() => undefined);
    if (seeded && seeded.length > 0) pubkeys = seeded;
  }
  writeSeed(PACK_SEED_KV, pubkeys);
  return pubkeys;
}

/**
 * Fetch the allow-listed community announcements (and, in the same round
 * trip, the NIP-09 un-publishes that remove listings). Used only as the
 * completeness fallback when the unfiltered directory read overflowed its
 * window — see {@link DiscoverDirectory}.
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
  return invites;
}

/**
 * Everything the Communities tab needs, fetched in ONE relay round trip: the
 * follow pack that seeds the author allow-list, every recent announcement
 * (UNFILTERED — the allow-list is applied client-side, so nothing unvetted
 * ever renders, but the pack read no longer serializes ahead of the
 * announcement read), and the NIP-09 un-publishes.
 */
export interface DiscoverDirectory {
  /** The team follow pack's member pubkeys (empty when unreadable). */
  packAuthors: string[];
  /**
   * Every parsed announcement, newest-first, deduped by link signer, with
   * un-published ones removed — NOT allow-list filtered. The hook filters at
   * render time against pack ∪ viewer ∪ follows.
   */
  invites: DiscoveredInvite[];
  /**
   * The unfiltered announcement read filled its whole `limit` window, so
   * allow-listed announcements may have been crowded out of it — the caller
   * should run the (slower, authors-filtered) fallback read for completeness.
   */
  overflow: boolean;
}

/** Fetch the {@link DiscoverDirectory}, persisting the warm-load seeds. */
async function fetchDiscoverDirectory(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  signal: AbortSignal,
): Promise<DiscoverDirectory> {
  const filters: NostrFilter[] = [
    { kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: FETCH_LIMIT },
    // Un-publishes, addressable by their `["k", "3314"]` tag
    // (ShareToDiscoverDialog always attaches it) rather than by the
    // announcement ids, which would serialize a second hop behind the first.
    { kinds: [5], "#k": [String(KIND_COMMUNITY_ANNOUNCEMENT)], limit: FETCH_LIMIT },
  ];
  if (TEAM_PACK_COORD) {
    const coord = TEAM_PACK_COORD;
    filters.push({ kinds: [coord.kind], authors: [coord.pubkey], "#d": [coord.identifier], limit: 1 });
  }
  const events = await nostr
    .group(relays)
    .query(filters, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });

  const packEvent = TEAM_PACK_COORD
    ? events
        .filter((e) => e.kind === TEAM_PACK_COORD.kind && e.pubkey === TEAM_PACK_COORD.pubkey)
        .sort((a, b) => b.created_at - a.created_at)[0]
    : undefined;
  let packAuthors = followPackPubkeys(packEvent);
  if (packAuthors.length === 0) {
    // The pack is a `limit: 1` addressable event piggybacked on the
    // announcements REQ, and a round trip that drops it reads as an empty
    // pack — which would collapse the allow-list and blank a grid that had
    // just painted. Treat empty as a probable miss and carry the last good
    // pack forward, mirroring writeSeed's fail-open rule.
    const seeded = await getArmadaDB()
      .kv.get<string[]>(PACK_SEED_KV)
      .catch(() => undefined);
    if (seeded && seeded.length > 0) packAuthors = seeded;
  }
  // Feed the standalone pack query's seed too (the Emojis/Themes tabs).
  writeSeed(PACK_SEED_KV, packAuthors);

  const anns = events.filter((e) => e.kind === KIND_COMMUNITY_ANNOUNCEMENT);
  const dels = events.filter((e) => e.kind === 5);
  // Honor un-publishes: a NIP-09 delete by the ANNOUNCEMENT'S OWN author
  // removes the listing (anyone else's delete is ignored).
  const deleted = new Set<string>();
  const byId = new Map(anns.map((e) => [e.id, e.pubkey]));
  for (const del of dels) {
    for (const [n, id] of del.tags) {
      if (n === "e" && byId.get(id) === del.pubkey) deleted.add(id);
    }
  }
  // Newest announcement wins for a given link.
  anns.sort((a, b) => b.created_at - a.created_at);
  const byLinkSigner = new Map<string, DiscoveredInvite>();
  for (const event of anns) {
    if (deleted.has(event.id)) continue;
    const invite = announcementFromEvent(event);
    if (!invite) continue;
    if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
  }
  let invites = [...byLinkSigner.values()];
  if (anns.length === 0) {
    // Same fail-open rule as the pack above: a round trip that returned NO
    // announcements at all is a probable miss (cold pool, dropped REQ), not
    // an emptied directory — returning it as truth would swap a painted grid
    // for the empty state on the next background refresh. Carry the last
    // good listing set forward; a real refresh overwrites it.
    const seeded = await getArmadaDB()
      .kv.get<DiscoverDirectory>(DIRECTORY_SEED_KV)
      .catch(() => undefined);
    if (seeded && seeded.invites.length > 0) invites = seeded.invites;
  }
  const directory: DiscoverDirectory = {
    packAuthors,
    invites,
    overflow: anns.length >= FETCH_LIMIT,
  };
  if (directory.invites.length > 0 || directory.packAuthors.length > 0) {
    getArmadaDB().kv.set(DIRECTORY_SEED_KV, directory).catch(() => undefined);
  }
  return directory;
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
  const { mutedPubkeys } = useMutedPubkeys();
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
    // A muted person is dropped from the allow-list, so the server-side
    // `authors` filter never asks for their content in the first place. This
    // covers the restricted path only — `discoverAllContent` sends no author
    // filter at all, which is why each feed also filters its results below.
    for (const pk of mutedPubkeys) set.delete(pk);
    // Sorted for a stable react-query key across renders.
    return [...set].sort();
  }, [pack.data, user, followList.data, mutedPubkeys]);

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
 * else. De-duplicated by link-signer keeping the newest announcement;
 * two DIFFERENT links to one community can only be recognized as duplicates
 * once their bundles resolve, so that fold happens in the Communities tab.
 *
 * One round trip: the follow pack and the announcements are fetched in a
 * single unfiltered REQ ({@link fetchDiscoverDirectory}) and the author
 * allow-list (pack ∪ viewer ∪ follows) is applied CLIENT-side here — the gate
 * is unchanged (nothing unvetted renders, and `discoverAllContent` still
 * bypasses it), but first paint no longer waits pack → announcements out in
 * sequence. If the unfiltered window overflowed (a flooder could crowd
 * allow-listed announcements out of the newest 100), a server-side
 * authors-filtered fallback read fills in the rest.
 *
 * No search filter is sent: the announcement deliberately carries no metadata
 * (the card resolves name/icon/banner live from the invite bundle), so there
 * is nothing server-side to match. The Communities tab filters the rendered
 * cards against their RESOLVED names instead.
 *
 * Returned alongside the invites: `packAuthors` (the team follow pack's
 * members) and `trustedAuthors` (pack ∪ viewer ∪ follows), so the tab can
 * rank listings — pack-owned communities first, the rest of the trusted set
 * after — without a second membership read.
 */
const NO_AUTHORS: string[] = [];

/**
 * Drop events authored by someone the user has muted.
 *
 * Discover's own gate is an author ALLOW-list, which `discoverAllContent`
 * turns off wholesale — so the allow-list can't be the only place muting is
 * honoured, or the setting that widens the directory would also un-mute
 * everyone in it.
 */
function useMuteFiltered<T extends { pubkey: string }>(events: T[] | undefined): T[] | undefined {
  const { mutedPubkeys } = useMutedPubkeys();
  return useMemo(() => {
    if (!events || mutedPubkeys.size === 0) return events;
    return events.filter((e) => !mutedPubkeys.has(e.pubkey));
  }, [events, mutedPubkeys]);
}

export function useDiscoverCommunities() {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const { config } = useAppContext();
  const relays = useDiscoverRelays();
  const { user } = useCurrentUser();
  const followList = useFollowList();

  const unrestricted = config.discoverAllContent;

  const directoryKey: QueryKey = ["discover", "directory", relays];
  // Warm loads: last session's directory paints immediately, then refreshes.
  useKvQuerySeed<DiscoverDirectory>(DIRECTORY_SEED_KV, directoryKey);

  const result = useQuery<DiscoverDirectory>({
    queryKey: directoryKey,
    enabled: relays.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: ({ signal }) => fetchDiscoverDirectory(nostr, relays, signal),
  });

  // The allow-list, assembled reactively: follows landing later just widen the
  // rendered set — no query re-keys, no refetch, no skeleton.
  const authors = useMemo(() => {
    const set = new Set<string>(result.data?.packAuthors ?? []);
    if (user) {
      set.add(user.pubkey);
      for (const pk of followList.data?.pubkeys ?? []) set.add(pk);
    }
    for (const pk of mutedPubkeys) set.delete(pk);
    return [...set].sort();
  }, [result.data?.packAuthors, user, followList.data, mutedPubkeys]);

  // Completeness fallback for the (rare) overflowed window — see the doc.
  const overflowed = !unrestricted && !!result.data?.overflow && authors.length > 0;
  const fallback = useQuery<DiscoveredInvite[]>({
    queryKey: communitiesQueryKey(relays, authors),
    enabled: overflowed,
    staleTime: 30_000,
    queryFn: ({ signal }) => fetchCommunityAnnouncements(nostr, relays, authors, signal),
  });

  const data = useMemo(() => {
    if (!result.data) return undefined;
    const allowed = unrestricted ? null : new Set(authors);
    const base = result.data.invites.filter(
      (invite) =>
        !mutedPubkeys.has(invite.source.pubkey)
        && (!allowed || allowed.has(invite.source.pubkey)),
    );
    if (!overflowed || !fallback.data) return base;
    // Union with the fallback's complete allow-listed set, newest-first,
    // link-signer deduped like the fetchers.
    const byLinkSigner = new Map<string, DiscoveredInvite>();
    const all = [...base, ...fallback.data].sort(
      (a, b) => b.source.created_at - a.source.created_at,
    );
    for (const invite of all) {
      if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
    }
    return [...byLinkSigner.values()];
  }, [result.data, unrestricted, authors, overflowed, fallback.data, mutedPubkeys]);

  // A failed refresh over a grid already painted (KV seed or placeholder)
  // must not swap real cards for the error state — error only when there is
  // nothing to show.
  return {
    data,
    packAuthors: result.data?.packAuthors ?? NO_AUTHORS,
    trustedAuthors: authors,
    isLoading: result.isLoading,
    isError: result.isError && !data,
  };
}

/** How long after boot the Discover warmup fires (chunk warmup fires at 3s). */
const WARM_DELAY_MS = 3500;
/** How many listings get their invite bundle pre-resolved (about a viewport). */
const WARM_BUNDLE_COUNT = 12;

/**
 * Pre-fetch the Discover data a first navigation needs, shortly after boot and
 * off the critical path: the directory (follow pack + announcements, one REQ)
 * and the first viewport's worth of invite bundles. Everything lands in the
 * shared react-query cache under the SAME keys the page hooks use, and — via
 * the fetcher's KV seed and the bundle floor — in local storage, so opening
 * Discover paints real cards immediately even in a session (or install) that
 * has never visited it. Best-effort throughout: a failed warmup just means the
 * page fetches for itself, exactly as if this hook didn't exist.
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
          const directory = await queryClient.fetchQuery({
            queryKey: ["discover", "directory", relays],
            staleTime: 30_000,
            queryFn: ({ signal }) => fetchDiscoverDirectory(nostr, relays, signal),
          });
          // Only warm bundles the page would actually render: the allow-list
          // applies here too (with whatever the follow list holds right now).
          const allowed = new Set(directory.packAuthors);
          if (pubkey) {
            allowed.add(pubkey);
            const follows = queryClient.getQueryData<FollowListData>(["follow-list", pubkey]);
            for (const pk of follows?.pubkeys ?? []) allowed.add(pk);
          }
          const visible = unrestricted
            ? directory.invites
            : directory.invites.filter((invite) => allowed.has(invite.source.pubkey));
          // Resolve the bundles the grid would show first: the tab ranks
          // pack-authored listings ahead of the rest, so warm those first.
          // (The pre-resolve announcement author stands in for the bundle
          // owner here, the same heuristic the tab's initial order uses.)
          // Sequenced behind the announcements by necessity; each resolve
          // also persists its floor, which is what makes the NEXT session's
          // cards instant.
          const packSet = new Set(directory.packAuthors);
          const prioritized = [
            ...visible.filter((invite) => packSet.has(invite.source.pubkey)),
            ...visible.filter((invite) => !packSet.has(invite.source.pubkey)),
          ];
          await Promise.allSettled(
            prioritized.slice(0, WARM_BUNDLE_COUNT).map((invite) => {
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

/**
 * A refetch that comes back with NOTHING where the same query previously had
 * results is a probable relay miss (cold pool, dropped REQ), not a directory
 * that emptied — an empty success would swap a painted grid for the empty
 * state. Applies only to no-query reads: an empty SEARCH result is an answer.
 */
function keepLastGoodPage(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: QueryKey,
  q: string,
): NostrRumor[] | undefined {
  if (q) return undefined;
  const prev = queryClient.getQueryData<NostrRumor[]>(queryKey);
  return prev && prev.length > 0 ? prev : undefined;
}

/** NIP-30 emoji packs (kind 30030). */
export function useDiscoverEmojiPacks(query: string) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const relays = useDiscoverRelays();
  const { authors, unrestricted, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const authorFilter = unrestricted ? undefined : authors;

  const queryKey: QueryKey = ["discover", "emoji-packs", relays, authorFilter ?? "all", debounced.trim()];
  const result = useQuery<NostrRumor[]>({
    queryKey,
    enabled: relays.length > 0 && !authorsLoading && (unrestricted || authors.length > 0),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, relays, KIND_EMOJI_SET, q, authorFilter, signal);
      if (events.length === 0) {
        const kept = keepLastGoodPage(queryClient, queryKey, q);
        if (kept) return kept;
      }
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

  // Outside the query so it also covers `discoverAllContent`, where no author
  // filter is sent to the relay at all.
  const data = useMuteFiltered(result.data);
  return { ...result, data, isLoading: result.isLoading || authorsLoading };
}

/** Shareable theme definitions (Ditto kind 36767). */
export function useDiscoverThemes(query: string) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const relays = useDiscoverRelays();
  const { authors, unrestricted, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const authorFilter = unrestricted ? undefined : authors;

  const queryKey: QueryKey = ["discover", "themes", relays, authorFilter ?? "all", debounced.trim()];
  const result = useQuery<NostrRumor[]>({
    queryKey,
    enabled: relays.length > 0 && !authorsLoading && (unrestricted || authors.length > 0),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const q = debounced.trim();
      const events = await fetchDiscover(nostr, relays, THEME_DEFINITION_KIND, q, authorFilter, signal);
      if (events.length === 0) {
        const kept = keepLastGoodPage(queryClient, queryKey, q);
        if (kept) return kept;
      }
      // Drop anything we can't render as a 3-color theme.
      const usable = events.filter((e) => parseDittoTheme(e) !== null);
      if (!q) return usable;
      const needle = q.toLowerCase();
      return usable.filter((e) => parseDittoTheme(e)?.title.toLowerCase().includes(needle));
    },
  });

  const data = useMuteFiltered(result.data);
  return { ...result, data, isLoading: result.isLoading || authorsLoading };
}
