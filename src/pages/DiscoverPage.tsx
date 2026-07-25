import { Compass, Loader2, Palette, Search, Smile, Users } from "lucide-react";
import { useState, type ReactNode } from "react";

import { CommunityListingCard } from "@/components/discover/CommunityListingCard";
import { ThemeDiscoverCard } from "@/components/discover/ThemeDiscoverCard";
import { EmojiPackCard } from "@/components/chat/EmojiPackCard";
import { ServerRail } from "@/components/layout/ServerRail";
import { Input } from "@/components/ui/input";
import {
  useDiscoverCommunities,
  useDiscoverEmojiPacks,
  useDiscoverThemes,
} from "@/hooks/useDiscover";
import { cn } from "@/lib/utils";

type DiscoverTab = "communities" | "emojis" | "themes";

const TABS: { id: DiscoverTab; label: string; icon: typeof Users; placeholder: string }[] = [
  { id: "communities", label: "Communities", icon: Users, placeholder: "Search public communities…" },
  { id: "emojis", label: "Emojis", icon: Smile, placeholder: "Search emoji packs…" },
  { id: "themes", label: "Themes", icon: Palette, placeholder: "Search themes…" },
];

/**
 * Discover: browse and search public directory events on Nostr — opt-in Concord
 * community listings (join links), NIP-30 emoji packs, and shareable themes.
 * Search uses NIP-50 where relays support it, with a client-side filter fallback
 * so results stay relevant on plain relays.
 */
export function DiscoverPage() {
  const [tab, setTab] = useState<DiscoverTab>("communities");
  // Independent query per tab so switching tabs doesn't carry a stale search.
  const [queries, setQueries] = useState<Record<DiscoverTab, string>>({
    communities: "",
    emojis: "",
    themes: "",
  });
  const query = queries[tab];
  const setQuery = (v: string) => setQueries((prev) => ({ ...prev, [tab]: v }));

  const active = TABS.find((t) => t.id === tab)!;

  return (
    <>
      <ServerRail />
      <main className="flex flex-col flex-1 min-w-0 h-full bg-background safe-area-top">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-14 shrink-0 border-b border-chrome-divider">
          <Compass className="size-5 text-primary" />
          <h1 className="text-lg font-semibold">Discover</h1>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 pt-3 shrink-0">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-pressed={tab === t.id}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors touch:px-4 touch:py-2",
                  tab === t.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="px-3 py-3 shrink-0">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={active.placeholder}
              className="pl-9"
              aria-label={active.placeholder}
            />
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable px-3 pb-8">
          {tab === "communities" && <CommunitiesTab query={query} />}
          {tab === "emojis" && <EmojisTab query={query} />}
          {tab === "themes" && <ThemesTab query={query} />}
        </div>
      </main>
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

function CommunitiesTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverCommunities(query);

  if (isLoading && !data) {
    return (
      <TabState>
        <Loader2 className="size-6 animate-spin" />
      </TabState>
    );
  }
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
    <div className="grid gap-3 pt-1 sm:grid-cols-2 xl:grid-cols-3">
      {data.map((listing) => (
        <CommunityListingCard key={listing.event.id} listing={listing} />
      ))}
    </div>
  );
}

function EmojisTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverEmojiPacks(query);

  if (isLoading && !data) {
    return (
      <TabState>
        <Loader2 className="size-6 animate-spin" />
      </TabState>
    );
  }
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
    <div className="grid gap-3 pt-1 sm:grid-cols-2 xl:grid-cols-3">
      {data.map((event) => (
        <EmojiPackCard key={event.id} event={event} className="max-w-none" />
      ))}
    </div>
  );
}

function ThemesTab({ query }: { query: string }) {
  const { data, isLoading, isError } = useDiscoverThemes(query);

  if (isLoading && !data) {
    return (
      <TabState>
        <Loader2 className="size-6 animate-spin" />
      </TabState>
    );
  }
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
    <div className="grid gap-3 pt-1 sm:grid-cols-2 xl:grid-cols-3">
      {data.map((event) => (
        <ThemeDiscoverCard key={event.id} event={event} />
      ))}
    </div>
  );
}

export default DiscoverPage;
