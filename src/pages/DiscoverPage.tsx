import { Compass, Loader2, Palette, Plus, Search, Smile, Users } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";

import { CommunityListingCard } from "@/components/discover/CommunityListingCard";
import { ThemeDiscoverCard } from "@/components/discover/ThemeDiscoverCard";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { ServerRail } from "@/components/layout/ServerRail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type DiscoverTab = "communities" | "emojis" | "themes";

const TABS: { id: DiscoverTab; label: string; icon: typeof Users; placeholder: string }[] = [
  { id: "communities", label: "Communities", icon: Users, placeholder: "Search communities…" },
  { id: "emojis", label: "Emojis", icon: Smile, placeholder: "Search emoji packs…" },
  { id: "themes", label: "Themes", icon: Palette, placeholder: "Search themes…" },
];

/**
 * Discover: browse and search public directory events on Nostr — opt-in Concord
 * community listings (join links), NIP-30 emoji packs, and shareable themes.
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
  const query = queries[tab];
  const setQuery = (v: string) => setQueries((prev) => ({ ...prev, [tab]: v }));
  const active = TABS.find((t) => t.id === tab)!;

  return (
    <>
      <ServerRail />
      <main className="flex flex-col flex-1 min-w-0 h-full bg-background">
        {/* Header — top padding matches the channel sidebar so the title lines
            up with the rail's first icon. */}
        <div className="flex items-center gap-2 px-4 pb-2.5 pt-[calc(1.5rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]">
          <Compass className="size-5 shrink-0 text-primary" />
          <h1 className="text-base font-semibold tracking-wide">Discover</h1>
        </div>

        {/* Tabs (underline) */}
        <div className="flex items-center gap-5 px-4 border-b border-chrome-divider">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-pressed={isActive}
                className={cn(
                  "relative flex items-center gap-1.5 py-2.5 text-sm font-medium transition-colors touch:py-3",
                  isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {t.label}
                {isActive && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>

        {/* Search + tab action */}
        <div className="flex items-center gap-2 px-4 py-2.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={active.placeholder}
              className="h-9 pl-9"
              aria-label={active.placeholder}
            />
          </div>
          {tab === "emojis" && user && (
            <Button size="sm" className="h-9 shrink-0 clip-corner-lg" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Create
            </Button>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable px-4 pb-8">
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
    </>
  );
}

/** Centered loader / empty-state scaffold shared by the tabs. */
function TabState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
      {children}
    </div>
  );
}

const GRID = "grid gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-3";

function CommunitiesTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverCommunities(query);

  if (isLoading && !data) return <TabState><Loader2 className="size-6 animate-spin" /></TabState>;
  if (isError) return <TabState><p>Couldn't reach the relays. Try again.</p></TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState>
        <Users className="size-8 opacity-40" />
        <p className="max-w-xs text-sm">
          {query.trim()
            ? "No public communities matched your search."
            : "No public communities listed yet. A community owner can list one when generating an invite link."}
        </p>
      </TabState>
    );
  }
  return (
    <div className={GRID}>
      {data.map((listing) => (
        <CommunityListingCard key={listing.event.id} listing={listing} />
      ))}
    </div>
  );
}

function EmojisTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverEmojiPacks(query);

  if (isLoading && !data) return <TabState><Loader2 className="size-6 animate-spin" /></TabState>;
  if (isError) return <TabState><p>Couldn't reach the relays. Try again.</p></TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState>
        <Smile className="size-8 opacity-40" />
        <p className="max-w-xs text-sm">
          {query.trim() ? "No emoji packs matched your search." : "No emoji packs found."}
        </p>
      </TabState>
    );
  }
  return (
    <div className={cn(GRID, "items-stretch")}>
      {data.map((event) => (
        <EmojiPackCard key={event.id} event={event} className="my-0 max-w-none" />
      ))}
    </div>
  );
}

function ThemesTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverThemes(query);

  if (isLoading && !data) return <TabState><Loader2 className="size-6 animate-spin" /></TabState>;
  if (isError) return <TabState><p>Couldn't reach the relays. Try again.</p></TabState>;
  if (!data || data.length === 0) {
    return (
      <TabState>
        <Palette className="size-8 opacity-40" />
        <p className="max-w-xs text-sm">
          {query.trim() ? "No themes matched your search." : "No shared themes found."}
        </p>
      </TabState>
    );
  }
  return (
    <div className={cn(GRID, "items-stretch")}>
      {data.map((event) => (
        <ThemeDiscoverCard key={event.id} event={event} />
      ))}
    </div>
  );
}

export default DiscoverPage;
