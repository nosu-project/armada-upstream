import { Compass, Palette, Plus, Search, Smile, Users, X } from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";

import {
  CommunityListingCard,
  CommunityListingCardSkeleton,
} from "@/components/discover/CommunityListingCard";
import { CreateCommunityCard } from "@/components/discover/CreateCommunityCard";
import { ThemeDiscoverCard } from "@/components/discover/ThemeDiscoverCard";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { DiscoveredInvite } from "@/concord-v2/lib/inviteDiscovery";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  useDiscoverCommunities,
  useDiscoverEmojiPacks,
  useDiscoverThemes,
} from "@/hooks/useDiscover";
import { cn } from "@/lib/utils";

const EmojiPackDialog = lazy(() =>
  import("@/components/discover/EmojiPackDialog").then((m) => ({ default: m.EmojiPackDialog })),
);

const ShareToDiscoverDialog = lazy(() =>
  import("@/concord-v2/components/ShareToDiscoverDialog").then((m) => ({
    default: m.ShareToDiscoverDialog,
  })),
);

type DiscoverTab = "communities" | "emojis" | "themes";

const TABS: { id: DiscoverTab; label: string; icon: typeof Users; placeholder: string }[] = [
  { id: "communities", label: "Communities", icon: Users, placeholder: "Search communities…" },
  { id: "emojis", label: "Emojis", icon: Smile, placeholder: "Search emoji packs…" },
  { id: "themes", label: "Themes", icon: Palette, placeholder: "Search themes…" },
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
  const query = queries[tab];
  const setQuery = (v: string) => setQueries((prev) => ({ ...prev, [tab]: v }));
  const active = TABS.find((t) => t.id === tab)!;

  return (
    <>
      <ServerRail />
      <main className="flex flex-col flex-1 min-w-0 h-full safe-area-top">
        {/* Header — the floating command bar shared with Inbox / Mesh / Group.
            Dropped on a phone, where the tab pills carry the page identity and
            the vertical space is better spent on results. */}
        <header className="relative h-12 touch:h-14 mx-2 mt-3 px-2 sidebar:px-3 hidden sm:flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
          <Compass className="size-5 shrink-0 text-muted-foreground" />
          <h1 className="min-w-0 flex-1 truncate font-semibold leading-tight">Discover</h1>
        </header>

        {/* Tab pills + search — one row from sm up, stacked on a phone. */}
        <div className="mx-2 mt-3 sm:mt-2 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
          {/* Three icon+label pills don't fit a 320px phone, and truncating
              "Communities" is worse than not showing it. So below sm only the
              active pill carries its label: it grows to fill the rail while the
              others collapse to their icon. The label animates via a 0fr→1fr
              grid column, which reaches its exact content width without any
              measuring or hardcoded max-width (and merely snaps, rather than
              breaking, where that interpolation is unsupported). */}
          <div className="flex w-full items-center gap-1 p-1 clip-corner-lg bg-chrome sm:w-auto sm:shrink-0">
            {TABS.map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-pressed={isActive}
                  aria-label={t.label}
                  className={cn(
                    "flex items-center justify-center overflow-hidden px-2 py-1.5 text-sm clip-corner-lg transition-all duration-200 ease-out motion-reduce:transition-none touch:py-2.5 sm:flex-none sm:px-3",
                    isActive
                      ? "flex-1 bg-primary font-medium text-primary-foreground sm:flex-none"
                      : "flex-none text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span
                    className={cn(
                      "grid transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none",
                      isActive ? "grid-cols-[1fr]" : "grid-cols-[0fr] sm:grid-cols-[1fr]",
                    )}
                  >
                    <span className="overflow-hidden whitespace-nowrap pl-1.5">{t.label}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex h-9 touch:h-11 min-w-0 flex-1 items-center gap-1.5 px-2 sidebar:px-3 clip-corner-lg bg-chrome">
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
                className="h-9 touch:h-11 shrink-0 clip-corner-lg"
                onClick={() => setShareOpen(true)}
              >
                <Plus className="size-4" />
                <span className="hidden sm:inline">Add your community</span>
                <span className="sr-only sm:hidden">Add your community</span>
              </Button>
            )}
            {tab === "emojis" && user && (
              <Button
                className="h-9 touch:h-11 shrink-0 clip-corner-lg"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="size-4" />
                <span className="hidden sm:inline">New pack</span>
                <span className="sr-only sm:hidden">Create emoji pack</span>
              </Button>
            )}
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable px-2 pb-8 pt-4 sm:pt-2">
          {tab === "communities" && <CommunitiesTab query={query} />}
          {tab === "emojis" && <EmojisTab query={query} />}
          {tab === "themes" && <ThemesTab query={query} />}
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
    </>
  );
}

const GRID = "grid gap-2 sm:grid-cols-2 xl:grid-cols-3 items-stretch";

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
  const { data, packAuthors, trustedAuthors, isLoading, isError } = useDiscoverCommunities();

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
    <div className={GRID}>
      {/* Founding a community is always the first vessel in the fleet. */}
      <CreateCommunityCard />
      {/* The announcement is metadata-free, so the search matches each card's
          RESOLVED community name: non-matching cards render nothing. */}
      {(ordered ?? [])
        .filter((invite) => !duplicates.has(invite.linkSigner))
        .map((invite) => (
          <CommunityListingCard
            key={invite.linkSigner}
            invite={invite}
            filter={query}
            onResolved={onResolved}
          />
        ))}
    </div>
  );
}

function EmojisTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverEmojiPacks(query);

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
    <div className={GRID}>
      {data.map((event) => (
        <EmojiPackCard key={event.id} event={event} className="my-0 max-w-none" />
      ))}
    </div>
  );
}

function ThemesTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverThemes(query);

  if (isLoading && !data) return <TabSkeleton />;
  if (isError) return <TabState icon={Palette}>Couldn't reach the relays. Try again.</TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState icon={Palette}>
        {query.trim()
          ? "No themes matched your search."
          : "No shared themes found. Share one from Settings → Appearance."}
      </TabState>
    );
  }
  return (
    <div className={GRID}>
      {data.map((event) => (
        <ThemeDiscoverCard key={event.id} event={event} />
      ))}
    </div>
  );
}

export default DiscoverPage;
