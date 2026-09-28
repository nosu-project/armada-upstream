import { useNostr } from "@nostrify/react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useDebounce } from "@/hooks/useDebounce";
import { useFollowList } from "@/hooks/useFollowList";
import { KIND_EMOJI_SET, emojiPackEntries, emojiPackName } from "@/hooks/useEmojiPacks";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { resolveBundle } from "@/concord/hooks/useCommunityActions";
import {
  activityByLinkSigner,
  discoverActivityBatches,
  type DiscoverActivityTarget,
} from "@/concord/lib/discoverActivity";
import { parseInviteLink } from "@/concord/lib/invite";
import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementFromEvent,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { getArmadaDB } from "@/lib/db/armadaDB";
import {
  curatedPubkeys,
  curationFilter,
  curationKey,
  isCurationEvent,
  resolveDiscoverCuration,
  resolveDiscoverRelays,
  type DiscoverCuration,
} from "@/lib/discoverSource";
import { normalizeRelayUrl } from "@/lib/platform";
import { THEME_DEFINITION_KIND, parseDittoTheme } from "@/lib/themeEvent";

import type { NostrFilter } from "@nostrify/nostrify";
import type { FollowListData } from "@/hooks/useFollowList";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Discover feeds: public community listings, NIP-30 emoji packs and themes.
 * Queries app relays directly, per relay, bypassing the pool's search router. With
 * a query, sends both a NIP-50 `search` filter and a plain filter, then filters
 * client-side, so non-NIP-50 relays still return results.
 */

const FETCH_LIMIT = 100;
const TIMEOUT_MS = 6000;

/**
 * Grace for slower relays after the first answers; the pool's 300ms EOSE cut
 * off slower relays holding most listings.
 */
const RELAY_GRACE_MS = 2500;

/** Run `filters` against each relay separately so a dead relay costs only its own events. */
async function queryEachRelay(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  filters: NostrFilter[],
  signal: AbortSignal,
): Promise<NostrRumor[][]> {
  const grace = new AbortController();
  const settled = AbortSignal.any([signal, grace.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const answers: NostrRumor[][] = [];
  await Promise.allSettled(
    relays.map(async (url) => {
      const events = await nostr.relay(url).query(filters, { signal: settled });
      answers.push(events);
      graceTimer ??= setTimeout(() => grace.abort(), RELAY_GRACE_MS);
    }),
  );
  clearTimeout(graceTimer);
  return answers;
}

function mergeAnswers(answers: NostrRumor[][]): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const events of answers) for (const event of events) byId.set(event.id, event);
  return [...byId.values()];
}

/**
 * Oldest `created_at` every relay's answer is complete down to, or `undefined` if
 * no relay filled its `limit`. Cut at the HIGHEST per-relay floor so dense relays
 * aren't skipped when paging.
 */
function windowFloor(
  answers: NostrRumor[][],
  inWindow: (event: NostrRumor) => boolean,
): number | undefined {
  let floor: number | undefined;
  for (const events of answers) {
    const times = events.filter(inWindow).map((e) => e.created_at);
    if (times.length < FETCH_LIMIT) continue;
    times.sort((a, b) => b - a);
    const nth = times[FETCH_LIMIT - 1];
    floor = floor === undefined ? nth : Math.max(floor, nth);
  }
  return floor;
}

/**
 * Warm-load seeds persisted in KV. Written into the cache already stale
 * (`updatedAt: 0`) so the network fetch still runs; never overwrite fetched data.
 */
const PACK_SEED_KV = "discover:seed:pack";
const DIRECTORY_SEED_KV = "discover:seed:directory";

function useKvQuerySeed<T>(kvKey: string, queryKey: QueryKey | undefined): void {
  const queryClient = useQueryClient();
  // Serialize so the effect re-runs when the key changes by value.
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

function writeSeed(kvKey: string, value: unknown[]): void {
  if (value.length === 0) return; // an empty read may be a miss — keep the last good seed
  getArmadaDB().kv.set(kvKey, value).catch(() => undefined);
}

/** Per curation source, so one source's membership never stands in for another's. */
function packSeedKey(curation: DiscoverCuration): string {
  return `${PACK_SEED_KV}:${curationKey(curation)}`;
}

/** Listings hold under any source; pack members only if seeded under the same one. */
function seededDirectory(stored: DiscoverDirectory, curation: DiscoverCuration): DiscoverDirectory {
  return stored.curation === curationKey(curation) ? stored : { ...stored, packAuthors: [] };
}

/**
 * The curation source in effect: the user's override or the build default (Armada
 * team follow pack, kind 39089). Its members seed the authorship of every Discover feed.
 */
export function useDiscoverCuration(): DiscoverCuration {
  const { config } = useAppContext();
  return useMemo(() => resolveDiscoverCuration(config.discoverCuration ?? ""), [config.discoverCuration]);
}

/** Relays named only by the curation source's hints, read for the list event alone. */
function extraCurationRelays(curation: DiscoverCuration, relays: string[]): string[] {
  if (curation.type === "none") return [];
  return curation.relays.filter((url) => !relays.includes(url));
}

function curationMembers(curation: DiscoverCuration, answers: NostrRumor[][]): string[] {
  const [event] = mergeAnswers(answers)
    .filter((e) => isCurationEvent(curation, e))
    .sort((a, b) => b.created_at - a.created_at);
  return curatedPubkeys(event);
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

interface DiscoverFeedPage {
  events: NostrRumor[];
  /** `until` for the next page ({@link windowFloor}); inclusive, overlap is deduped. */
  cursor: number | undefined;
}

async function fetchDiscoverPage(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  kind: number,
  query: string,
  authors: string[] | undefined,
  signal: AbortSignal,
  until: number | undefined,
): Promise<DiscoverFeedPage> {
  // `authors === undefined` bypasses the allow-list; callers guard against an empty array.
  const base: NostrFilter = { kinds: [kind], limit: FETCH_LIMIT };
  if (authors) base.authors = authors;
  if (until !== undefined) base.until = until;
  const filters: NostrFilter[] = [base];
  if (query) filters.push({ ...base, search: query });

  const answers = await queryEachRelay(nostr, relays, filters, signal);
  // Judged on raw per-relay counts (pre-dedup) so collapsed pages still page on.
  const cursor = windowFloor(answers, () => true);
  const events = mergeAnswers(answers).filter((e) => cursor === undefined || e.created_at >= cursor);
  return { events: newestPerAddr(events), cursor };
}

/**
 * App relays plus the user's own NIP-65 relays (any marker). Independent of
 * `useUserRelays`, which governs the general pool.
 */
export function useDiscoverRelays(): string[] {
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  // `?.`: partial configs (test doubles of AppContext) may lack relay metadata.
  const metadata = config.relayMetadata;
  const own = useMemo(() => {
    if (!user || !metadata) return [];
    // A mirror left from a previous account is not this user's list.
    if (metadata.pubkey && metadata.pubkey !== user.pubkey) return [];
    return metadata.relays.map((r) => r.url);
  }, [user, metadata]);
  return useMemo(() => resolveDiscoverRelays(config.appRelays, own), [config.appRelays, own]);
}

/** Where to look for the viewer's own listings; `useNostrPublish` sends them to the app relays. */
export function useListingRelays(): string[] {
  return useDiscoverRelays();
}

function packQueryKey(relays: string[], curation: DiscoverCuration): QueryKey {
  return ["discover", "follow-pack", curationKey(curation), relays];
}

function communitiesQueryKey(relays: string[], authorFilter: string[] | undefined): QueryKey {
  return ["discover", "community-announcements", relays, authorFilter ?? "all"];
}

async function fetchFollowPack(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  curation: DiscoverCuration,
  signal: AbortSignal,
): Promise<string[]> {
  const filter = curationFilter(curation);
  if (!filter) return [];
  const answers = await queryEachRelay(
    nostr,
    [...relays, ...extraCurationRelays(curation, relays)],
    [filter],
    signal,
  );
  // Newest across relays: a stale version must not win by answering first.
  let pubkeys = curationMembers(curation, answers);
  if (pubkeys.length === 0) {
    // An empty read is a probable miss, and an empty pack would blank painted feeds;
    // carry the last good membership forward.
    const seeded = await getArmadaDB()
      .kv.get<string[]>(packSeedKey(curation))
      .catch(() => undefined);
    if (seeded && seeded.length > 0) pubkeys = seeded;
  }
  writeSeed(packSeedKey(curation), pubkeys);
  return pubkeys;
}

/**
 * Honor un-publishes only from the announcement's own author (NIP-09); keep the
 * newest announcement per link signer.
 */
function foldAnnouncements(anns: NostrRumor[], dels: NostrRumor[]): DiscoveredInvite[] {
  const deleted = new Set<string>();
  const byId = new Map(anns.map((e) => [e.id, e.pubkey]));
  for (const del of dels) {
    for (const [n, id] of del.tags) {
      if (n === "e" && byId.get(id) === del.pubkey) deleted.add(id);
    }
  }
  const byLinkSigner = new Map<string, DiscoveredInvite>();
  for (const event of [...anns].sort((a, b) => b.created_at - a.created_at)) {
    if (deleted.has(event.id)) continue;
    const invite = announcementFromEvent(event);
    if (!invite) continue;
    if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
  }
  return [...byLinkSigner.values()];
}

const isAnnouncement = (e: NostrRumor) => e.kind === KIND_COMMUNITY_ANNOUNCEMENT;

function announcementWindow(answers: NostrRumor[][]): {
  anns: NostrRumor[];
  dels: NostrRumor[];
  cursor: number | undefined;
} {
  const cursor = windowFloor(answers, isAnnouncement);
  const events = mergeAnswers(answers);
  return {
    anns: events.filter((e) => isAnnouncement(e) && (cursor === undefined || e.created_at >= cursor)),
    dels: events.filter((e) => e.kind === 5),
    cursor,
  };
}

/** Fetch community announcements plus the NIP-09 un-publishes in one round trip. */
async function fetchCommunityAnnouncements(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  authorFilter: string[] | undefined,
  signal: AbortSignal,
  until?: number,
): Promise<{ invites: DiscoveredInvite[]; cursor: number | undefined }> {
  const filter: NostrFilter = { kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: FETCH_LIMIT };
  if (authorFilter) filter.authors = authorFilter;
  if (until !== undefined) filter.until = until;
  // Un-listing always tags `["k", "3314"]` (ShareToDiscoverDialog), so deletes are
  // queried by kind instead of serializing a second hop on announcement ids.
  const delFilter: NostrFilter = {
    kinds: [5],
    "#k": [String(KIND_COMMUNITY_ANNOUNCEMENT)],
    limit: FETCH_LIMIT,
  };
  if (authorFilter) delFilter.authors = authorFilter;
  if (until !== undefined) delFilter.until = until;
  const answers = await queryEachRelay(nostr, relays, [filter, delFilter], signal);
  const { anns, dels, cursor } = announcementWindow(answers);
  return { invites: foldAnnouncements(anns, dels), cursor };
}

/**
 * Everything the Communities tab needs in one round trip. Announcements are
 * UNFILTERED; the allow-list is applied client-side.
 */
export interface DiscoverDirectory {
  packAuthors: string[];
  /** Newest-first, deduped by link signer, un-publishes removed — NOT allow-list filtered. */
  invites: DiscoveredInvite[];
  /**
   * The unfiltered read filled its `limit`, so allow-listed announcements may have been
   * crowded out; run the authors-filtered fallback.
   */
  overflow: boolean;
  /** Absent from older seeds, which fall back to the oldest listing. */
  cursor?: number;
  /**
   * The curation source `packAuthors` was read from; absent from older seeds, whose
   * pack members are then not trusted.
   */
  curation?: string;
}

async function fetchDiscoverDirectory(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  curation: DiscoverCuration,
  signal: AbortSignal,
): Promise<DiscoverDirectory> {
  const filters: NostrFilter[] = [
    { kinds: [KIND_COMMUNITY_ANNOUNCEMENT], limit: FETCH_LIMIT },
    // Addressed by `["k", "3314"]` tag (see fetchCommunityAnnouncements).
    { kinds: [5], "#k": [String(KIND_COMMUNITY_ANNOUNCEMENT)], limit: FETCH_LIMIT },
  ];
  const packFilter = curationFilter(curation);
  if (packFilter) filters.push(packFilter);
  // Hint-only relays are asked for the list alone, never for announcements.
  const hinted = extraCurationRelays(curation, relays);
  const [answers, hintAnswers] = await Promise.all([
    queryEachRelay(nostr, relays, filters, signal),
    packFilter && hinted.length > 0
      ? queryEachRelay(nostr, hinted, [packFilter], signal)
      : Promise.resolve([]),
  ]);

  let packAuthors = curationMembers(curation, [...answers, ...hintAnswers]);
  if (packAuthors.length === 0 && packFilter) {
    // An empty pack is a probable miss (dropped `limit: 1` event); carry the last good pack forward.
    const seeded = await getArmadaDB()
      .kv.get<string[]>(packSeedKey(curation))
      .catch(() => undefined);
    if (seeded && seeded.length > 0) packAuthors = seeded;
  }
  // Feed the standalone pack query's seed too (Emojis/Themes tabs).
  writeSeed(packSeedKey(curation), packAuthors);

  const { anns, dels, cursor } = announcementWindow(answers);
  let invites = foldAnnouncements(anns, dels);
  let overflow = cursor !== undefined;
  let nextCursor = cursor;
  if (anns.length === 0) {
    // No announcements at all is a probable miss, not an emptied directory; carry the
    // last good listings forward. A seeded read reports no overflow, so never paginates.
    const seeded = await getArmadaDB()
      .kv.get<DiscoverDirectory>(DIRECTORY_SEED_KV)
      .catch(() => undefined);
    if (seeded && seeded.invites.length > 0) invites = seeded.invites;
    overflow = false;
    nextCursor = undefined;
  }
  const directory: DiscoverDirectory = {
    packAuthors,
    invites,
    overflow,
    cursor: nextCursor,
    curation: curationKey(curation),
  };
  if (directory.invites.length > 0 || directory.packAuthors.length > 0) {
    getArmadaDB().kv.set(DIRECTORY_SEED_KV, directory).catch(() => undefined);
  }
  return directory;
}

interface CommunitiesPage {
  /** Carried only by page 1 (`until === undefined`). */
  packAuthors: string[];
  invites: DiscoveredInvite[];
  overflow: boolean;
  cursor: number | undefined;
}

/**
 * Page 1 is the full {@link fetchDiscoverDirectory}; deeper pages are older
 * announcements only, UNFILTERED so a widening follow list never refetches the feed.
 */
async function fetchCommunitiesPage(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  curation: DiscoverCuration,
  until: number | undefined,
  signal: AbortSignal,
): Promise<CommunitiesPage> {
  if (until === undefined) {
    return directoryPage(await fetchDiscoverDirectory(nostr, relays, curation, signal));
  }
  const { invites, cursor } = await fetchCommunityAnnouncements(nostr, relays, undefined, signal, until);
  return { packAuthors: [], invites, overflow: false, cursor };
}

function directoryPage(dir: DiscoverDirectory): CommunitiesPage {
  return {
    packAuthors: dir.packAuthors,
    invites: dir.invites,
    overflow: dir.overflow,
    cursor: dir.overflow ? (dir.cursor ?? oldestInviteCursor(dir.invites)) : undefined,
  };
}

/** The cursor of a seed that predates `cursor`. */
function oldestInviteCursor(invites: DiscoveredInvite[]): number | undefined {
  let oldest: number | undefined;
  for (const invite of invites) {
    if (oldest === undefined || invite.source.created_at < oldest) oldest = invite.source.created_at;
  }
  return oldest;
}

/**
 * Local echo of an un-listing: drop it from every cached copy (feed, fallback, seed)
 * so it disappears now and a seed fallback can't paint it back.
 */
export async function forgetDiscoverAnnouncements(
  queryClient: QueryClient,
  announcementIds: Iterable<string>,
): Promise<void> {
  const gone = new Set(announcementIds);
  if (gone.size === 0) return;
  const keep = (invite: DiscoveredInvite) => !gone.has(invite.source.id);
  queryClient.setQueriesData<InfiniteData<CommunitiesPage>>(
    { queryKey: ["discover", "directory-infinite"] },
    (data) =>
      data && { ...data, pages: data.pages.map((page) => ({ ...page, invites: page.invites.filter(keep) })) },
  );
  queryClient.setQueriesData<DiscoveredInvite[]>(
    { queryKey: ["discover", "community-announcements"] },
    (data) => data?.filter(keep),
  );
  try {
    const seed = await getArmadaDB().kv.get<DiscoverDirectory>(DIRECTORY_SEED_KV);
    if (seed && seed.invites.some((invite) => !keep(invite))) {
      await getArmadaDB().kv.set(DIRECTORY_SEED_KV, { ...seed, invites: seed.invites.filter(keep) });
    }
  } catch {
    // Best-effort: the next successful read rewrites the seed anyway.
  }
  void queryClient.invalidateQueries({ queryKey: ["discover", "directory-infinite"] });
  void queryClient.invalidateQueries({ queryKey: ["discover", "community-announcements"] });
}

/** Authors-independent but not source-independent: page 1 carries the curated members. */
function directoryInfiniteKey(relays: string[], curation: DiscoverCuration): QueryKey {
  return ["discover", "directory-infinite", relays, curationKey(curation)];
}

/** Shared by the page hook and {@link useWarmDiscover} so both prime the same cache entry. */
function communitiesInfiniteOptions(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  curation: DiscoverCuration,
) {
  return {
    queryKey: directoryInfiniteKey(relays, curation),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: number | undefined; signal: AbortSignal }) =>
      fetchCommunitiesPage(nostr, relays, curation, pageParam, signal),
    getNextPageParam: (lastPage: CommunitiesPage) => lastPage.cursor,
  };
}

/**
 * The author allow-list gating every Discover feed: the curated list's members,
 * plus the viewer and their follows when logged in.
 * Fail-closed: empty means show nothing — some relays treat empty `authors` as no
 * filter, so callers must NOT query when empty. `discoverAllContent` bypasses it all.
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

  const curation = useDiscoverCuration();

  const unrestricted = config.discoverAllContent;
  const curated = curation.type !== "none";

  const packKey = packQueryKey(relays, curation);
  useKvQuerySeed<string[]>(packSeedKey(curation), unrestricted || !curated ? undefined : packKey);

  const pack = useQuery<string[]>({
    queryKey: packKey,
    enabled: relays.length > 0 && curated && !unrestricted,
    staleTime: 60 * 60 * 1000,
    queryFn: ({ signal }) => fetchFollowPack(nostr, relays, curation, signal),
  });

  const authors = useMemo(() => {
    const set = new Set<string>(pack.data ?? []);
    if (user) {
      set.add(user.pubkey);
      for (const pk of followList.data?.pubkeys ?? []) set.add(pk);
    }
    // Covers the restricted path only; `discoverAllContent` sends no author filter, so each
    // feed also filters its results.
    for (const pk of mutedPubkeys) set.delete(pk);
    // Sorted for a stable react-query key.
    return [...set].sort();
  }, [pack.data, user, followList.data, mutedPubkeys]);

  return {
    authors,
    unrestricted,
    // Only the pack read gates the feeds; follows merely widen the list and re-key later
    // (`placeholderData` holds results meanwhile).
    isLoading: unrestricted || !curated ? false : pack.isLoading,
  };
}

/**
 * Public Concord communities (kind-3314 announcements whose content is an invite link),
 * deduped by link signer. Pack and announcements come in one unfiltered REQ and the
 * allow-list is applied client-side; if that window overflowed, an authors-filtered
 * fallback fills in. No search filter: announcements carry no metadata to match.
 */
const NO_AUTHORS: string[] = [];

export function useDiscoverCommunities(): DiscoverFeed<DiscoveredInvite> & {
  packAuthors: string[];
  trustedAuthors: string[];
} {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const { config } = useAppContext();
  const relays = useDiscoverRelays();
  const { user } = useCurrentUser();
  const followList = useFollowList();
  const queryClient = useQueryClient();
  const curation = useDiscoverCuration();

  const unrestricted = config.discoverAllContent;

  // Warm load: seed last session's directory as the (stale) first page.
  useEffect(() => {
    if (relays.length === 0) return;
    const key = directoryInfiniteKey(relays, curation);
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getArmadaDB().kv.get<DiscoverDirectory>(DIRECTORY_SEED_KV);
        if (cancelled || !stored) return;
        if (queryClient.getQueryData(key) !== undefined) return;
        queryClient.setQueryData(
          key,
          { pages: [directoryPage(seededDirectory(stored, curation))], pageParams: [undefined] },
          { updatedAt: 0 },
        );
      } catch {
        // Best-effort: an unreadable seed just means a skeleton first paint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relays, curation, queryClient]);

  const result = useInfiniteQuery({
    ...communitiesInfiniteOptions(nostr, relays, curation),
    enabled: relays.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const packAuthors = result.data?.pages[0]?.packAuthors ?? NO_AUTHORS;

  // Assembled client-side so follows landing later widen the set without a refetch.
  const authors = useMemo(() => {
    const set = new Set<string>(packAuthors);
    if (user) {
      set.add(user.pubkey);
      for (const pk of followList.data?.pubkeys ?? []) set.add(pk);
    }
    for (const pk of mutedPubkeys) set.delete(pk);
    return [...set].sort();
  }, [packAuthors, user, followList.data, mutedPubkeys]);

  // Fallback for an overflowed first window (a flooder could crowd out allow-listed ones).
  const overflowed = !unrestricted && !!result.data?.pages[0]?.overflow && authors.length > 0;
  const fallback = useQuery<DiscoveredInvite[]>({
    queryKey: communitiesQueryKey(relays, authors),
    enabled: overflowed,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await fetchCommunityAnnouncements(nostr, relays, authors, signal)).invites,
  });

  const data = useMemo(() => {
    if (!result.data) return undefined;
    const allInvites = result.data.pages.flatMap((p) => p.invites);
    const allowed = unrestricted ? null : new Set(authors);
    const base = allInvites.filter(
      (invite) =>
        !mutedPubkeys.has(invite.source.pubkey)
        && (!allowed || allowed.has(invite.source.pubkey)),
    );
    const source = !overflowed || !fallback.data ? base : [...base, ...fallback.data];
    const byLinkSigner = new Map<string, DiscoveredInvite>();
    for (const invite of [...source].sort((a, b) => b.source.created_at - a.source.created_at)) {
      if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
    }
    return [...byLinkSigner.values()];
  }, [result.data, unrestricted, authors, overflowed, fallback.data, mutedPubkeys]);

  // Error only when there is nothing painted to show.
  return {
    data,
    packAuthors,
    trustedAuthors: authors,
    isLoading: result.isLoading,
    isError: result.isError && !data,
    fetchNextPage: result.fetchNextPage,
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    pageCount: result.data?.pages.length,
  };
}

/** Chunk warmup fires at 3s. */
const WARM_DELAY_MS = 3500;
const WARM_BUNDLE_COUNT = 12;

/**
 * Best-effort prefetch shortly after boot of the directory and first viewport's
 * invite bundles, under the same keys the page hooks use.
 */
export function useWarmDiscover(): void {
  const { nostr } = useNostr();
  const { config } = useAppContext();
  const relays = useDiscoverRelays();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const curation = useDiscoverCuration();

  const unrestricted = config.discoverAllContent;
  const pubkey = user?.pubkey;

  useEffect(() => {
    if (relays.length === 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // Same infinite-query entry and cursor options the page reads.
          const infinite = await queryClient.fetchInfiniteQuery({
            ...communitiesInfiniteOptions(nostr, relays, curation),
            staleTime: 30_000,
          });
          const directory = infinite.pages[0] ?? { packAuthors: [], invites: [] };
          // Only warm bundles the page would render (allow-list applies here too).
          const allowed = new Set(directory.packAuthors);
          if (pubkey) {
            allowed.add(pubkey);
            const follows = queryClient.getQueryData<FollowListData>(["follow-list", pubkey]);
            for (const pk of follows?.pubkeys ?? []) allowed.add(pk);
          }
          const visible = unrestricted
            ? directory.invites
            : directory.invites.filter((invite) => allowed.has(invite.source.pubkey));
          // Warm pack-authored listings first, matching the tab's ranking; the announcement
          // author stands in for the bundle owner.
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
  }, [nostr, queryClient, relays, curation, unrestricted, pubkey]);
}

/** Coalesce Control peeks, each of which expands a card's author set, into one REQ. */
const ACTIVITY_DEBOUNCE_MS = 1000;

/**
 * Batched last-active probe for Discover cards: a `limit: 1` kind-1059 filter per
 * community, one REQ per relay set. Wrap metadata only, no decrypt.
 */
export function useDiscoverCommunityActivity(
  targets: DiscoverActivityTarget[],
): Record<string, number> {
  const { nostr } = useNostr();

  // Stable key: reorders of the same set must not refetch.
  const targetsKey = useMemo(() => {
    const rows = targets
      .filter((t) => t.authors.length > 0 && t.relays.length > 0)
      .map((t) => ({
        linkSigner: t.linkSigner,
        authors: [...t.authors].sort(),
        relays: [...t.relays].map(normalizeRelayUrl).filter(Boolean).sort(),
      }))
      .sort((a, b) => a.linkSigner.localeCompare(b.linkSigner));
    return JSON.stringify(rows);
  }, [targets]);

  const debouncedTargetsKey = useDebounce(targetsKey, ACTIVITY_DEBOUNCE_MS);

  const result = useQuery<Record<string, number>>({
    queryKey: ["discover", "community-activity", debouncedTargetsKey],
    enabled: debouncedTargetsKey !== "[]",
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
    queryFn: async ({ signal }) => {
      const parsed = JSON.parse(debouncedTargetsKey) as DiscoverActivityTarget[];
      const now = Math.floor(Date.now() / 1000);
      const batches = discoverActivityBatches(parsed, now);
      if (batches.length === 0) return {};
      // Per relay, so the first to answer can't cut off one holding a newer wrap.
      const pages = await Promise.all(
        batches.map((b) => queryEachRelay(nostr, b.relays, b.filters, signal)),
      );
      const events = pages.flatMap(mergeAnswers);
      return activityByLinkSigner(parsed, events, now);
    },
  });

  return result.data ?? {};
}

export interface DiscoverFeed<T> {
  data: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** Lets the sentinel auto-fetch page 2 after page 1. */
  pageCount: number | undefined;
}

/** NIP-30 emoji packs (kind 30030), cursor-paginated. */
export function useDiscoverEmojiPacks(query: string): DiscoverFeed<NostrRumor> {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const relays = useDiscoverRelays();
  const { authors, unrestricted, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const authorFilter = unrestricted ? undefined : authors;
  const q = debounced.trim();

  const result = useInfiniteQuery({
    queryKey: ["discover", "emoji-packs", relays, authorFilter ?? "all", q],
    enabled: relays.length > 0 && !authorsLoading && (unrestricted || authors.length > 0),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchDiscoverPage(nostr, relays, KIND_EMOJI_SET, q, authorFilter, signal, pageParam),
    getNextPageParam: (lastPage: DiscoverFeedPage) => lastPage.cursor,
  });

  // Muting is applied here, outside the query, so it covers `discoverAllContent` too.
  const data = useMemo(() => {
    if (!result.data) return undefined;
    const events = newestPerAddr(result.data.pages.flatMap((p) => p.events));
    let usable = events.filter((e) => emojiPackEntries(e).length > 0);
    if (q) {
      const needle = q.toLowerCase();
      usable = usable.filter((e) => {
        const shortcodes = emojiPackEntries(e).map((x) => x.shortcode).join(" ");
        return `${emojiPackName(e)} ${shortcodes}`.toLowerCase().includes(needle);
      });
    }
    if (mutedPubkeys.size > 0) usable = usable.filter((e) => !mutedPubkeys.has(e.pubkey));
    return usable;
  }, [result.data, q, mutedPubkeys]);

  return {
    data,
    isLoading: result.isLoading || authorsLoading,
    isError: result.isError && !data,
    fetchNextPage: result.fetchNextPage,
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    pageCount: result.data?.pages.length,
  };
}

/** Shareable theme definitions (Ditto kind 36767), cursor-paginated. */
export function useDiscoverThemes(query: string): DiscoverFeed<NostrRumor> {
  const { nostr } = useNostr();
  const { mutedPubkeys } = useMutedPubkeys();
  const relays = useDiscoverRelays();
  const { authors, unrestricted, isLoading: authorsLoading } = useDiscoverAuthors();
  const debounced = useDebounce(query, 300);

  const authorFilter = unrestricted ? undefined : authors;
  const q = debounced.trim();

  const result = useInfiniteQuery({
    queryKey: ["discover", "themes", relays, authorFilter ?? "all", q],
    enabled: relays.length > 0 && !authorsLoading && (unrestricted || authors.length > 0),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchDiscoverPage(nostr, relays, THEME_DEFINITION_KIND, q, authorFilter, signal, pageParam),
    getNextPageParam: (lastPage: DiscoverFeedPage) => lastPage.cursor,
  });

  const data = useMemo(() => {
    if (!result.data) return undefined;
    const events = newestPerAddr(result.data.pages.flatMap((p) => p.events));
    let usable = events.filter((e) => parseDittoTheme(e) !== null);
    if (q) {
      const needle = q.toLowerCase();
      usable = usable.filter((e) => parseDittoTheme(e)?.title.toLowerCase().includes(needle));
    }
    if (mutedPubkeys.size > 0) usable = usable.filter((e) => !mutedPubkeys.has(e.pubkey));
    return usable;
  }, [result.data, q, mutedPubkeys]);

  return {
    data,
    isLoading: result.isLoading || authorsLoading,
    isError: result.isError && !data,
    fetchNextPage: result.fetchNextPage,
    hasNextPage: result.hasNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
    pageCount: result.data?.pages.length,
  };
}
