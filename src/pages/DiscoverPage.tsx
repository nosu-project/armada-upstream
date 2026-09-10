import { Compass, Loader2, Palette, Plus, Search, Smile, Users, X } from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";

import {
  CommunityListingCard,
  CommunityListingCardSkeleton,
} from "@/components/discover/CommunityListingCard";
import { CreateCommunityCard } from "@/components/discover/CreateCommunityCard";
import { ThemeDiscoverCard } from "@/components/discover/ThemeDiscoverCard";
import { DeferredRow } from "@/components/DeferredRow";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiscoverActivityTarget } from "@/concord/lib/discoverActivity";
import type { DiscoveredInvite } from "@/concord/lib/inviteDiscovery";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  useDiscoverCommunities,
  useDiscoverCommunityActivity,
  useDiscoverEmojiPacks,
  useDiscoverThemes,
} from "@/hooks/useDiscover";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";

const EmojiPackDialog = lazy(() =>
  import("@/components/discover/EmojiPackDialog").then((m) => ({ default: m.EmojiPackDialog })),
);

const ShareToDiscoverDialog = lazy(() =>
  import("@/concord/components/ShareToDiscoverDialog").then((m) => ({
    default: m.ShareToDiscoverDialog,
  })),
);

const ThemeCreatorDialog = lazy(() =>
  import("@/components/discover/ThemeCreatorDialog").then((m) => ({ default: m.ThemeCreatorDialog })),
);

type DiscoverTab = "communities" | "emojis" | "themes";

const TABS: (PillTab<DiscoverTab> & { placeholder: string; blurb: string })[] = [
  {
    id: "communities",
    label: "Communities",
    icon: Users,
    placeholder: "Search communities…",
    blurb: "Encrypted communities you can join with a link. No server, no host.",
  },
  {
    id: "emojis",
    label: "Emojis",
    icon: Smile,
    placeholder: "Search emoji packs…",
    blurb: "Custom emoji packs shared across Nostr. Add one to your reactions.",
  },
  {
    id: "themes",
    label: "Themes",
    icon: Palette,
    placeholder: "Search themes…",
    blurb: "Community-made color themes you can preview and apply in a tap.",
  },
];

/**
 * Discover: browse and search public directory events on Nostr — opt-in Concord
 * community listings (join links), NIP-30 emoji packs, and shareable themes.
 * Framed in the app's chrome idiom: a floating command bar, cut-corner tab
 * pills, and a chrome search vessel over a card grid.
 */
export function DiscoverPage() {
  const { user } = useCurrentUser();
  const [tab, setTab] = useState<DiscoverTab>("communities");
  // Independent query per tab so switching tabs doesn't carry a stale search.
  const [queries, setQueries] = useState<Record<DiscoverTab, string>>({
    communities: "",
    emojis: "",
    themes: "",
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [themeCreateOpen, setThemeCreateOpen] = useState(false);
  const query = queries[tab];
  const setQuery = (v: string) => setQueries((prev) => ({ ...prev, [tab]: v }));
  const active = TABS.find((t) => t.id === tab)!;

  return (
    <>
      <ServerRail />
      <main className="flex flex-col flex-1 min-w-0 h-full safe-area-top">
        {/* A centred, bounded column — the same presentational width the
            moderation and community-settings surfaces use, so Discover reads as
            an inviting page rather than a full-bleed grid. */}
        <div className="mx-auto flex w-full max-w-5xl flex-1 min-h-0 flex-col px-3 sm:px-4">
          {/* Header — the floating command bar shared with Inbox / Mesh / Group.
              Dropped on a phone, where the tab pills carry the page identity and
              the vertical space is better spent on results. */}
          <header className="relative h-12 touch:h-14 mt-4 px-3 hidden sm:flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
            <Compass className="size-5 shrink-0 text-muted-foreground" />
            <h1 className="min-w-0 flex-1 truncate font-semibold leading-tight">Discover</h1>
          </header>

          {/* What the current tab surfaces — desktop only, where there's room to
              set the page's intent before the grid. */}
          <p className="hidden sm:block mt-3 px-1 text-sm text-muted-foreground">{active.blurb}</p>

          {/* Tab pills + search — one row from sm up, stacked on a phone. On a
              phone the vessels are the server rail's size-12 grid, spaced on its
              gap-4 rhythm, so the two read as one idiom. */}
          <div className="mt-3 flex shrink-0 flex-col gap-4 sm:mt-5 sm:flex-row sm:items-center sm:gap-3">
            <PillTabs
              tabs={TABS}
              value={tab}
              onChange={(id) => setTab(id)}
              className="h-12 sm:h-auto"
            />

            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="flex h-12 sm:h-9 min-w-0 flex-1 items-center gap-1.5 px-2 sidebar:px-3 clip-corner-lg bg-chrome">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setQuery("");
                  }}
                  placeholder={active.placeholder}
                  aria-label={active.placeholder}
                  className="h-full flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                />
                {query && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Clear search"
                    className="size-7 touch:size-9 shrink-0 text-muted-foreground"
                    onClick={() => setQuery("")}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>

              {/* Lives beside the search, not in the header, so it survives the
                  header being dropped on a phone. */}
              {tab === "communities" && user && (
                <Button
                  className="h-12 sm:h-9 shrink-0 clip-corner-lg"
                  onClick={() => setShareOpen(true)}
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">Add your community</span>
                  <span className="sr-only sm:hidden">Add your community</span>
                </Button>
              )}
              {tab === "emojis" && user && (
                <Button
                  className="h-12 sm:h-9 shrink-0 clip-corner-lg"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">New pack</span>
                  <span className="sr-only sm:hidden">Create emoji pack</span>
                </Button>
              )}

              {/* Second tenant of the same slot — the two never co-render. */}
              {tab === "themes" && user && (
                <Button
                  className="h-12 sm:h-9 shrink-0 clip-corner-lg"
                  onClick={() => setThemeCreateOpen(true)}
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">New theme</span>
                  <span className="sr-only sm:hidden">Create theme</span>
                </Button>
              )}
            </div>
          </div>

          {/* Results — the top spacing is a MARGIN, not scroll padding, so the
              gap under the search bar stays put as the grid scrolls beneath it. */}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable mt-4 sm:mt-6 pb-8">
            {tab === "communities" && <CommunitiesTab query={query} />}
            {tab === "emojis" && <EmojisTab query={query} />}
            {tab === "themes" && <ThemesTab query={query} />}
          </div>
        </div>
      </main>

      {createOpen && (
        <Suspense fallback={null}>
          <EmojiPackDialog open={createOpen} onOpenChange={setCreateOpen} />
        </Suspense>
      )}

      {shareOpen && (
        <Suspense fallback={null}>
          <ShareToDiscoverDialog open={shareOpen} onOpenChange={setShareOpen} />
        </Suspense>
      )}

      {themeCreateOpen && (
        <Suspense fallback={null}>
          <ThemeCreatorDialog open={themeCreateOpen} onOpenChange={setThemeCreateOpen} />
        </Suspense>
      )}
    </>
  );
}

const GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch";

/**
 * The infinite-scroll trigger, placed after a grid. The `ref` is
 * {@link useInfiniteScroll}'s sentinel — reaching it (a screenful early) fetches
 * the next page. A spinner shows only while that fetch is in flight; the div
 * keeps a little height either way so the observer has something to catch.
 */
function LoadMore({
  sentinelRef,
  loading,
}: {
  sentinelRef: (node: Element | null) => void;
  loading: boolean;
}) {
  return (
    <div ref={sentinelRef} className="flex justify-center py-6" aria-hidden={!loading}>
      {loading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
    </div>
  );
}

/**
 * Card-shaped placeholders while the first page loads — the grid keeps its
 * final shape instead of collapsing to a centred spinner and jumping.
 */
function TabSkeleton() {
  return (
    <div className={GRID} aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-40 w-full rounded-xl" />
      ))}
    </div>
  );
}

/** Centered empty / error state, in the cut-corner vessel idiom. */
function TabState({ icon: Icon, children }: { icon: typeof Users; children: ReactNode }) {
  return (
    <div className="mx-auto mt-6 flex max-w-sm flex-col items-center gap-3 clip-corner-lg bg-chrome px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center clip-corner-lg bg-foreground/5 text-muted-foreground">
        <Icon className="size-6" />
      </span>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function CommunitiesTab({ query }: { query: string }) {
  const {
    data,
    packAuthors,
    trustedAuthors,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    pageCount,
  } = useDiscoverCommunities();
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pageCount,
  });

  // Cross-link de-duplication and owner-based ranking: an announcement names
  // no community and no owner (only its resolved bundle does, verifiably), so
  // each card reports its bundle's community_id and owner as it lands.
  const [resolved, setResolved] = useState<Record<string, { communityId: string; owner: string }>>(
    {},
  );
  const onResolved = useCallback(
    (linkSigner: string, communityId: string, owner: string) =>
      setResolved((prev) => {
        const cur = prev[linkSigner];
        if (cur?.communityId === communityId && cur?.owner === owner) return prev;
        return { ...prev, [linkSigner]: { communityId, owner } };
      }),
    [],
  );

  // Activity probe targets reported by each card as its bundle (and, for
  // members, Control fold) resolves — batched into one last-wrap REQ below.
  const [activityTargets, setActivityTargets] = useState<Record<string, DiscoverActivityTarget>>(
    {},
  );
  const onActivityTarget = useCallback(
    (linkSigner: string, target: DiscoverActivityTarget | null) => {
      setActivityTargets((prev) => {
        // Withdrawn: the card unmounted or lost the search. Drop it, or the
        // REQ keeps asking about listings that are no longer on screen.
        if (!target) {
          if (!(linkSigner in prev)) return prev;
          const { [linkSigner]: _gone, ...rest } = prev;
          return rest;
        }
        const normalized: DiscoverActivityTarget = {
          ...target,
          authors: [...target.authors].sort(),
          relays: [...target.relays],
        };
        const cur = prev[linkSigner];
        if (
          cur
          && cur.authors.length === normalized.authors.length
          && cur.authors.every((a, i) => a === normalized.authors[i])
          && cur.relays.length === normalized.relays.length
          && cur.relays.every((r, i) => r === normalized.relays[i])
        ) {
          return prev;
        }
        return { ...prev, [linkSigner]: normalized };
      });
    },
    [],
  );
  const activityTargetList = useMemo(() => Object.values(activityTargets), [activityTargets]);
  const lastActiveBySigner = useDiscoverCommunityActivity(activityTargetList);

  // Display order: communities owned by team-follow-pack members first, then
  // the rest of the trusted set (pack ∪ viewer ∪ follows), then — only in
  // unrestricted mode, where the allow-list is bypassed — everyone else.
  // Newest-first within each tier (a stable partition preserves the hook's
  // order). The verified bundle owner ranks a card once it resolves; until
  // then the announcement's author stands in, so the first paint is already
  // ordered and a card only moves in the rare case the sharer isn't the
  // owner. O(n) over ≤ a few hundred listings — no extra fetches.
  const ordered = useMemo(() => {
    if (!data) return data;
    const pack = new Set(packAuthors);
    const trusted = new Set(trustedAuthors);
    const tiers: [DiscoveredInvite[], DiscoveredInvite[], DiscoveredInvite[]] = [[], [], []];
    for (const invite of data) {
      const owner = resolved[invite.linkSigner]?.owner ?? invite.source.pubkey;
      tiers[pack.has(owner) ? 0 : trusted.has(owner) ? 1 : 2].push(invite);
    }
    return tiers.flat();
  }, [data, resolved, packAuthors, trustedAuthors]);

  // Every link AFTER the first — in display order, so a pack-owned card wins
  // the fold — that resolves to an already-seen community is dropped. Until a
  // bundle resolves its card simply shows.
  const duplicates = useMemo(() => {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const invite of ordered ?? []) {
      const communityId = resolved[invite.linkSigner]?.communityId;
      if (!communityId) continue;
      if (seen.has(communityId)) dup.add(invite.linkSigner);
      else seen.add(communityId);
    }
    return dup;
  }, [ordered, resolved]);

  if (isLoading && !data) {
    // Card-shaped placeholders, enough of them to fill a desktop viewport.
    // The create tile is real content and never waits on the network.
    return (
      <div className={GRID}>
        <CreateCommunityCard />
        {Array.from({ length: 11 }, (_, i) => (
          <CommunityListingCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (isError) return <TabState icon={Users}>Couldn't reach the relays. Try again.</TabState>;
  if (!data || data.length === 0) {
    return (
      <div className="space-y-4">
        <div className={GRID}>
          <CreateCommunityCard />
        </div>
        <TabState icon={Users}>
          No public communities listed yet. Yours could be the first.
        </TabState>
      </div>
    );
  }
  return (
    <>
    <div className={GRID}>
      {/* Founding a community is always the first vessel in the fleet. */}
      <CreateCommunityCard />
      {/* The announcement is metadata-free, so the search matches each card's
          RESOLVED community name: non-matching cards render nothing. */}
      {(ordered ?? [])
        .filter((invite) => !duplicates.has(invite.linkSigner))
        .map((invite) => (
          // Deferred mount: the grid has no windowing, so mapping every listing
          // used to mount all ~FETCH_LIMIT cards at once — each a live bundle
          // resolve, an IntersectionObserver, two image decrypts and effects
          // that re-sort the parent as they land, O(n²) as the grid grows. Gate
          // on a screenful of lead time so first paint mounts only what's in
          // view. Disabled while searching: a card hides itself on a miss, and a
          // placeholder must not reserve height for a row that renders nothing.
          <DeferredRow key={invite.linkSigner} active={!query.trim()} minHeight={240}>
            <CommunityListingCard
              invite={invite}
              filter={query}
              onResolved={onResolved}
              onActivityTarget={onActivityTarget}
              lastActiveAt={lastActiveBySigner[invite.linkSigner]}
            />
          </DeferredRow>
        ))}
    </div>
    <LoadMore sentinelRef={sentinelRef} loading={isFetchingNextPage} />
    </>
  );
}

function EmojisTab({ query }: { query: string }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, pageCount } =
    useDiscoverEmojiPacks(query);
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pageCount,
  });

  if (isLoading && !data) return <TabSkeleton />;
  if (isError) return <TabState icon={Smile}>Couldn't reach the relays. Try again.</TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState icon={Smile}>
        {query.trim()
          ? "No emoji packs matched your search."
          : "No emoji packs found. Publish one with New pack and it'll show up here."}
      </TabState>
    );
  }
  return (
    <>
      <div className={GRID}>
        {/* Deferred mount, like the Communities grid: an unbounded paginated
            list of emoji cards (each decoding a strip of images) mounts only a
            screenful at a time. Not gated on search — these cards never
            self-hide, so a placeholder always resolves to a real card. */}
        {data.map((event) => (
          <DeferredRow key={event.id} active minHeight={160}>
            <EmojiPackCard event={event} className="my-0 max-w-none" />
          </DeferredRow>
        ))}
      </div>
      <LoadMore sentinelRef={sentinelRef} loading={isFetchingNextPage} />
    </>
  );
}

function ThemesTab({ query }: { query: string }) {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, pageCount } =
    useDiscoverThemes(query);
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pageCount,
  });

  if (isLoading && !data) return <TabSkeleton />;
  if (isError) return <TabState icon={Palette}>Couldn't reach the relays. Try again.</TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState icon={Palette}>
        {query.trim()
          ? "No themes matched your search."
          : "No shared themes found. Publish one with New theme and it'll show up here."}
      </TabState>
    );
  }
  return (
    <>
      <div className={GRID}>
        {data.map((event) => (
          <DeferredRow key={event.id} active minHeight={160}>
            <ThemeDiscoverCard event={event} />
          </DeferredRow>
        ))}
      </div>
      <LoadMore sentinelRef={sentinelRef} loading={isFetchingNextPage} />
    </>
  );
}

export default DiscoverPage;
