import { Compass, Info, Loader2, Palette, Plus, Search, SlidersHorizontal, Smile, Users, X } from "lucide-react";
import { lazy, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiscoverActivityTarget } from "@/concord/lib/discoverActivity";
import type { DiscoveredInvite } from "@/concord/lib/inviteDiscovery";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  useDiscoverCommunities,
  useDiscoverCuration,
  useDiscoverCommunityActivity,
  useDiscoverEmojiPacks,
  useDiscoverThemes,
} from "@/hooks/useDiscover";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { SettingsOverlayContext } from "@/lib/settingsOverlay";
import { cn } from "@/lib/utils";

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
 * Discover: public directory events — opt-in Concord community listings, NIP-30
 * emoji packs, and themes.
 */
export function DiscoverPage() {
  const { user } = useCurrentUser();
  // `?tab=` lets a link land on a tab.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<DiscoverTab>(() => {
    const requested = searchParams.get("tab");
    return TABS.find((t) => t.id === requested)?.id ?? "communities";
  });
  // Independent query per tab so switching doesn't carry a stale search.
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
        <div className="mx-auto flex w-full max-w-5xl flex-1 min-h-0 flex-col px-3 sm:px-4">
          {/* Dropped on phones, where the tab pills carry the page identity. */}
          <header className="relative h-12 touch:h-14 mt-4 px-3 hidden sm:flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
            <Compass className="size-5 shrink-0 text-muted-foreground" />
            <h1 className="min-w-0 flex-1 truncate font-semibold leading-tight">Discover</h1>
            <DiscoverScopeInfo signedIn={!!user} />
          </header>

          <p className="hidden sm:block mt-3 px-1 text-sm text-muted-foreground">{active.blurb}</p>

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

              {/* Beside the search, not in the header, so it survives on phones. */}
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

          {/* Top spacing is a MARGIN so the gap stays put while the grid scrolls. */}
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable mt-3 sm:mt-4 pb-8">
            {tab === "communities" && <CommunitiesTab query={query} />}
            {tab === "emojis" && <EmojisTab query={query} />}
            {tab === "themes" && <ThemesTab query={query} />}
            <DiscoverScopeFooter signedIn={!!user} className="sm:hidden" />
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

/**
 * Info popover on what the grid is drawn from, linking to the relay settings.
 * A popover (not a tooltip) because it holds a focusable button.
 */
function DiscoverScopeInfo({ signedIn, className }: { signedIn: boolean; className?: string }) {
  const { hint, unrestricted } = useDiscoverScopeHint(signedIn);
  const settings = useContext(SettingsOverlayContext);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="What Discover shows"
          className={cn("size-8 touch:size-11 shrink-0 text-muted-foreground", className)}
        >
          <Info className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3 text-xs text-muted-foreground">
        <p className="leading-snug">{hint}</p>
        <Button
          variant="secondary"
          size="sm"
          className="h-8 touch:h-11 w-full text-xs"
          onClick={() => {
            setOpen(false);
            settings.show("discover");
          }}
        >
          <SlidersHorizontal className="size-3.5" />
          {unrestricted ? "Discover settings" : "Show everything"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** What the grid is drawn from, in words — shared by the popover and the phone footer. */
function useDiscoverScopeHint(signedIn: boolean): { hint: string; unrestricted: boolean } {
  const { config } = useAppContext();
  const curation = useDiscoverCuration();
  const unrestricted = config.discoverAllContent;

  const hint = unrestricted
    ? "Showing everything posted to your relays, by anyone. None of it is filtered or moderated, so expect spam and things you may not want to see."
    : curation.type !== "none"
      ? signedIn
        ? "Showing picks from a curated list and from people you follow. Everything else on your relays is hidden."
        : "Showing picks from a curated list. Sign in to also see what people you follow have shared."
      : signedIn
        ? "Showing only what you and people you follow have shared."
        : "Sign in to see picks from people you follow.";

  return { hint, unrestricted };
}

/** The popover's content inline after the results, for phones (no header there). */
function DiscoverScopeFooter({ signedIn, className }: { signedIn: boolean; className?: string }) {
  const { hint, unrestricted } = useDiscoverScopeHint(signedIn);
  const settings = useContext(SettingsOverlayContext);

  return (
    <div className={cn("mt-2 flex flex-col items-center gap-3 px-4 text-center", className)}>
      <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
      <Button
        variant="secondary"
        size="sm"
        className="h-8 touch:h-11 text-xs"
        onClick={() => settings.show("discover")}
      >
        <SlidersHorizontal className="size-3.5" />
        {unrestricted ? "Discover settings" : "Show everything"}
      </Button>
    </div>
  );
}

const GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 items-stretch";

/** Infinite-scroll sentinel after a grid ({@link useInfiniteScroll}); spinner while fetching. */
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

/** Card-shaped placeholders so the grid keeps its shape while loading. */
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
  const unrestricted = useAppContext().config.discoverAllContent;
  const sentinelRef = useInfiniteScroll({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pageCount,
  });

  // Announcements name no community/owner; each card reports its resolved
  // bundle's, for cross-link dedup and owner ranking.
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

  // Activity-probe targets reported per card, batched into one last-wrap REQ.
  const [activityTargets, setActivityTargets] = useState<Record<string, DiscoverActivityTarget>>(
    {},
  );
  const onActivityTarget = useCallback(
    (linkSigner: string, target: DiscoverActivityTarget | null) => {
      setActivityTargets((prev) => {
        // Withdrawn (unmounted or filtered out): drop it from the REQ.
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

  // Order: curated-list owners, then the trusted set (list ∪ viewer ∪
  // follows), then everyone else; newest-first within tiers. Until a bundle
  // resolves, the announcement author stands in for its owner.
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

  // Drop later links resolving to an already-seen community (display order,
  // so pack-owned cards win).
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
          {unrestricted
            ? "No public communities listed yet. Yours could be the first."
            : "None of the authors Discover is showing have listed a community yet. Yours could be the first."}
        </TabState>
      </div>
    );
  }
  return (
    <>
    <div className={GRID}>
      <CreateCommunityCard />
      {/* Search matches each card's RESOLVED name; misses render nothing. */}
      {(ordered ?? [])
        .filter((invite) => !duplicates.has(invite.linkSigner))
        .map((invite) => (
          // No windowing, so defer mounting to a screenful of lead time. Off
          // while searching: cards self-hide on a miss.
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
        {/* Deferred mount like Communities; these cards never self-hide. */}
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
