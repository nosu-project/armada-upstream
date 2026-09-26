import { useNostr } from "@nostrify/react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { nip19 } from "nostr-tools";
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
 * relays everything non-group uses) one relay at a time ({@link queryEachRelay}),
 * merging the answers. Going direct
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
 * How long the other relays get after the FIRST one answers. Not the pool's
 * 300ms `eoseTimeout`: that is tuned for timelines, where the fastest relay is
 * representative of the rest, and on Discover it let a quick relay holding a
 * handful of listings cut off every slower relay holding the rest.
 */
const RELAY_GRACE_MS = 2500;

/**
 * Run `filters` against each relay SEPARATELY and return each answering
 * relay's events. Every relay waits for its own EOSE; once the first has
 * answered the rest get {@link RELAY_GRACE_MS}, and {@link TIMEOUT_MS} caps it
 * all, so a dead relay costs only its own events.
 */
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

/** Union of the per-relay answers, deduped by event id. */
function mergeAnswers(answers: NostrRumor[][]): NostrRumor[] {
  const byId = new Map<string, NostrRumor>();
  for (const events of answers) for (const event of events) byId.set(event.id, event);
  return [...byId.values()];
}

/**
 * The oldest `created_at` every relay's answer is complete down to, or
 * `undefined` when no relay filled its `limit` window (nothing older to page).
 *
 * Each relay that came back full is complete only down to its `limit`-th
 * newest matching event, and those floors differ by relay: one relay's 100
 * newest may span a day and another's a year. Paging from the union's oldest
 * event would skip everything the dense relay holds in between, so a page is
 * cut at the HIGHEST floor and the next page starts there.
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

/** One page of a Discover feed, plus where the next page starts. */
interface DiscoverFeedPage {
  /** Newest-first, deduped by addressable coordinate within the page. */
  events: NostrRumor[];
  /**
   * The `until` for the page AFTER this one ({@link windowFloor}), or
   * `undefined` when every relay came back under-full — nothing older to page.
   * `until` is inclusive; cross-page addr/id dedup absorbs the overlap.
   */
  cursor: number | undefined;
}

/** Shared paginated fetch across the app relays (one page per `until`). */
async function fetchDiscoverPage(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  kind: number,
  query: string,
  authors: string[] | undefined,
  signal: AbortSignal,
  until: number | undefined,
): Promise<DiscoverFeedPage> {
  // `authors === undefined` means the allow-list is bypassed (the unfiltered
  // firehose). An empty array would be sent as-is, which callers guard against.
  const base: NostrFilter = { kinds: [kind], limit: FETCH_LIMIT };
  if (authors) base.authors = authors;
  if (until !== undefined) base.until = until;
  const filters: NostrFilter[] = [base];
  // Add a NIP-50 search filter alongside the recent one so search-capable
  // relays surface deeper matches; relays that ignore `search` still answer the
  // plain filter, and the caller filters client-side either way.
  if (query) filters.push({ ...base, search: query });

  const answers = await queryEachRelay(nostr, relays, filters, signal);
  // Judged on each relay's raw count (pre-dedup), so a page whose addresses
  // collapse still pages on rather than stopping early.
  const cursor = windowFloor(answers, () => true);
  const events = mergeAnswers(answers).filter((e) => cursor === undefined || e.created_at >= cursor);
  return { events: newestPerAddr(events), cursor };
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
  const answers = await queryEachRelay(
    nostr,
    relays,
    [{ kinds: [coord.kind], authors: [coord.pubkey], "#d": [coord.identifier], limit: 1 }],
    signal,
  );
  // Newest across relays: a relay holding a stale version must not win by
  // answering first.
  const [event] = mergeAnswers(answers).sort((a, b) => b.created_at - a.created_at);
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
 * Fold announcements into listings: honor un-publishes (a NIP-09 delete by the
 * ANNOUNCEMENT'S OWN author removes the listing; anyone else's delete is
 * ignored), and keep the newest announcement per link signer.
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

/**
 * Split merged per-relay answers into the announcement window (cut at
 * {@link windowFloor}) and the un-publishes.
 */
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

/**
 * Fetch community announcements (and, in the same round trip, the NIP-09
 * un-publishes that remove listings) — the directory's deeper pages, and the
 * allow-listed completeness fallback when the unfiltered first window
 * overflowed (see {@link DiscoverDirectory}).
 */
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
  // Un-listing always attaches a `["k", "3314"]` tag (ShareToDiscoverDialog),
  // so the deletes are addressable by kind up front instead of by the
  // announcement ids, which would serialize a second relay hop behind the
  // first. Windowed by the same `until` so a deeper page carries the deletes
  // for its own announcements.
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
  /**
   * Where the next page starts ({@link windowFloor}). Absent from seeds
   * written before it existed, which fall back to the oldest listing.
   */
  cursor?: number;
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
  const answers = await queryEachRelay(nostr, relays, filters, signal);

  const packEvent = TEAM_PACK_COORD
    ? mergeAnswers(answers)
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

  const { anns, dels, cursor } = announcementWindow(answers);
  let invites = foldAnnouncements(anns, dels);
  let overflow = cursor !== undefined;
  let nextCursor = cursor;
  if (anns.length === 0) {
    // Same fail-open rule as the pack above: a round trip that returned NO
    // announcements at all is a probable miss (cold pool, dropped REQ), not
    // an emptied directory — returning it as truth would swap a painted grid
    // for the empty state on the next background refresh. Carry the last
    // good listing set forward; a real refresh overwrites it. A seeded read
    // reports no overflow, so it never paginates.
    const seeded = await getArmadaDB()
      .kv.get<DiscoverDirectory>(DIRECTORY_SEED_KV)
      .catch(() => undefined);
    if (seeded && seeded.invites.length > 0) invites = seeded.invites;
    overflow = false;
    nextCursor = undefined;
  }
  const directory: DiscoverDirectory = { packAuthors, invites, overflow, cursor: nextCursor };
  if (directory.invites.length > 0 || directory.packAuthors.length > 0) {
    getArmadaDB().kv.set(DIRECTORY_SEED_KV, directory).catch(() => undefined);
  }
  return directory;
}

/** One page of the paginated Communities directory. */
interface CommunitiesPage {
  /** Team follow-pack members — carried only by page 1 (`until === undefined`). */
  packAuthors: string[];
  /** Announcements in this window, deduped by link signer, un-publishes removed. */
  invites: DiscoveredInvite[];
  /** Page 1's unfiltered window overflowed — arm the authors-filtered fallback. */
  overflow: boolean;
  /** The `until` for the next page; `undefined` when there is nothing older. */
  cursor: number | undefined;
}

/**
 * Fetch one page of the directory. Page 1 is the full one-round-trip
 * {@link fetchDiscoverDirectory} (pack + newest announcements + un-publishes,
 * with the warm seeds and fail-open rules). Deeper pages are older
 * announcements only, kept UNFILTERED — the allow-list stays client-side so a
 * follow list that widens later never re-keys and refetches the whole feed.
 */
async function fetchCommunitiesPage(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
  until: number | undefined,
  signal: AbortSignal,
): Promise<CommunitiesPage> {
  if (until === undefined) return directoryPage(await fetchDiscoverDirectory(nostr, relays, signal));
  const { invites, cursor } = await fetchCommunityAnnouncements(nostr, relays, undefined, signal, until);
  return { packAuthors: [], invites, overflow: false, cursor };
}

/** A directory as the infinite query's first page. */
function directoryPage(dir: DiscoverDirectory): CommunitiesPage {
  return {
    packAuthors: dir.packAuthors,
    invites: dir.invites,
    overflow: dir.overflow,
    cursor: dir.overflow ? (dir.cursor ?? oldestInviteCursor(dir.invites)) : undefined,
  };
}

/** The oldest listing's time — the cursor of a seed that predates `cursor`. */
function oldestInviteCursor(invites: DiscoveredInvite[]): number | undefined {
  let oldest: number | undefined;
  for (const invite of invites) {
    if (oldest === undefined || invite.source.created_at < oldest) oldest = invite.source.created_at;
  }
  return oldest;
}

/**
 * Drop un-listed announcements from every cached copy of the directory — the
 * infinite feed, the overflow fallback and the warm-load seed — so the author
 * who just deleted them sees the card go at once instead of on the next
 * refresh, and a later "empty read" fallback can't paint it back from the
 * seed. The deletion itself is what removes the listing for everyone else;
 * this is only the local echo of it.
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

/** The infinite-query key for the directory (authors-independent — see the hook). */
function directoryInfiniteKey(relays: string[]): QueryKey {
  return ["discover", "directory-infinite", relays];
}

/**
 * Shared `useInfiniteQuery`/`fetchInfiniteQuery` options for the directory, so
 * the page hook and the boot warmup ({@link useWarmDiscover}) prime the exact
 * same cache entry through the same cursor logic.
 */
function communitiesInfiniteOptions(
  nostr: ReturnType<typeof useNostr>["nostr"],
  relays: string[],
) {
  return {
    queryKey: directoryInfiniteKey(relays),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: number | undefined; signal: AbortSignal }) =>
      fetchCommunitiesPage(nostr, relays, pageParam, signal),
    getNextPageParam: (lastPage: CommunitiesPage) => lastPage.cursor,
  };
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

  const unrestricted = config.discoverAllContent;

  // Warm load: last session's directory paints immediately, seeded as the
  // infinite query's first page (STALE, so the live fetch still runs and
  // overwrites it — a seed accelerates first paint, it never suppresses a
  // refresh). The plain-shaped KV seed is wrapped into the `{ pages }` shape.
  useEffect(() => {
    if (relays.length === 0) return;
    const key = directoryInfiniteKey(relays);
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getArmadaDB().kv.get<DiscoverDirectory>(DIRECTORY_SEED_KV);
        if (cancelled || !stored) return;
        if (queryClient.getQueryData(key) !== undefined) return;
        queryClient.setQueryData(
          key,
          { pages: [directoryPage(stored)], pageParams: [undefined] },
          { updatedAt: 0 },
        );
      } catch {
        // Best-effort: an unreadable seed just means a skeleton first paint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relays, queryClient]);

  const result = useInfiniteQuery({
    ...communitiesInfiniteOptions(nostr, relays),
    enabled: relays.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // The pack is fetched once, on page 1.
  const packAuthors = result.data?.pages[0]?.packAuthors ?? NO_AUTHORS;

  // The allow-list, assembled reactively: follows landing later just widen the
  // rendered set — no query re-keys, no refetch, no skeleton.
  const authors = useMemo(() => {
    const set = new Set<string>(packAuthors);
    if (user) {
      set.add(user.pubkey);
      for (const pk of followList.data?.pubkeys ?? []) set.add(pk);
    }
    for (const pk of mutedPubkeys) set.delete(pk);
    return [...set].sort();
  }, [packAuthors, user, followList.data, mutedPubkeys]);

  // Completeness fallback for the (rare) overflowed FIRST window — a flooder
  // could crowd allow-listed announcements out of the newest 100. Pagination
  // reaches older ones by scroll; this fills the first screen server-side.
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
    // Newest announcement wins per link signer, across pages and the fallback.
    const source = !overflowed || !fallback.data ? base : [...base, ...fallback.data];
    const byLinkSigner = new Map<string, DiscoveredInvite>();
    for (const invite of [...source].sort((a, b) => b.source.created_at - a.source.created_at)) {
      if (!byLinkSigner.has(invite.linkSigner)) byLinkSigner.set(invite.linkSigner, invite);
    }
    return [...byLinkSigner.values()];
  }, [result.data, unrestricted, authors, overflowed, fallback.data, mutedPubkeys]);

  // A failed refresh over a grid already painted (KV seed or placeholder)
  // must not swap real cards for the error state — error only when there is
  // nothing to show.
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
          // Prime the SAME infinite-query cache entry the page reads, through
          // the same cursor options — its first page is the directory.
          const infinite = await queryClient.fetchInfiniteQuery({
            ...communitiesInfiniteOptions(nostr, relays),
            staleTime: 30_000,
          });
          const directory = infinite.pages[0] ?? { packAuthors: [], invites: [] };
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
 * How long to wait after the last activity-target change before issuing the
 * batched last-wrap REQ. Control peeks land one-by-one and each expands a
 * card's author set (public chat streams); without a coalesce window that
 * re-keyed this query per peek (~N REQs for N cards).
 */
const ACTIVITY_DEBOUNCE_MS = 1000;

/**
 * Batched last-active probe for Discover community cards: a `limit: 1` filter
 * per community (newest kind-1059 wrap across that community's derivable
 * stream authors), grouped into one REQ per relay set. Cards paint first; this
 * fills in timestamps without blocking. No decrypt — only wrap metadata.
 *
 * Target updates are debounced so a burst of Control-peek enrichments collapses
 * into a single REQ; `placeholderData` keeps the prior timestamps on screen
 * while the coalesced fetch runs.
 */
export function useDiscoverCommunityActivity(
  targets: DiscoverActivityTarget[],
): Record<string, number> {
  const { nostr } = useNostr();

  // Stable key: linkSigner → sorted authors + relays. Reorders of the same
  // set must not refetch.
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
      // Per relay, so the relay that answers first can't cut off one holding a
      // newer wrap; an unreachable relay costs only its own events.
      const pages = await Promise.all(
        batches.map((b) => queryEachRelay(nostr, b.relays, b.filters, signal)),
      );
      const events = pages.flatMap(mergeAnswers);
      return activityByLinkSigner(parsed, events, now);
    },
  });

  return result.data ?? {};
}

/**
 * A paginated Discover feed's return shape — what the tab needs to render the
 * grid and drive {@link useInfiniteScroll}.
 */
export interface DiscoverFeed<T> {
  data: T[] | undefined;
  isLoading: boolean;
  isError: boolean;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** Loaded page count — lets the sentinel auto-fetch page 2 after page 1. */
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

  // Narrow the flattened pages once, here: cross-page addr dedup (a newer
  // version paged in later wins), the "carries emojis" usability gate, the
  // client-side search match, and muting — the last outside the query so it
  // covers `discoverAllContent`, where no author filter reaches the relay.
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
    // Drop anything we can't render as a 3-color theme.
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
