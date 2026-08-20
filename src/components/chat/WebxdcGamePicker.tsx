import { useMemo, useState } from "react";
import { Blocks, ImageOff, Loader2, Search, Users } from "lucide-react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFollowList } from "@/hooks/useFollowList";
import { useWebxdcApps, type WebxdcApp } from "@/hooks/useWebxdcApps";
import { sanitizeImageSrc } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";

/** One game row: icon + name, clickable to attach. */
function GameRow({ app, onSelect }: { app: WebxdcApp; onSelect: (app: WebxdcApp) => void }) {
  const [iconError, setIconError] = useState(false);
  // A published game's icon URL is chosen by whoever published it.
  const icon = sanitizeImageSrc(app.icon);
  return (
    <button
      type="button"
      onClick={() => onSelect(app)}
      className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left hover:bg-secondary/60 transition-colors"
    >
      <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
        {icon && !iconError ? (
          <img src={icon} alt="" className="size-full object-cover" onError={() => setIconError(true)} />
        ) : (
          <Blocks className="size-5 text-primary" />
        )}
      </div>
      <span className="text-sm font-medium truncate">{app.name}</span>
    </button>
  );
}

/**
 * Browse webxdc apps/games published as Nostr events (NIP-94 kind 1063) and pick
 * one to attach. Rendered as an inline composer panel (like the GIF picker):
 * a search box, a "Follows" filter, and a scrolling list. `onSelect` hands the
 * chosen app back to the composer, which attaches it with a fresh session id.
 */
export function WebxdcGamePicker({
  onSelect,
  relays,
}: {
  onSelect: (app: WebxdcApp) => void;
  /** Extra relays to search alongside the default pool (e.g. the community's). */
  relays?: string[];
}) {
  const [query, setQuery] = useState("");
  const [followsOnly, setFollowsOnly] = useState(false);
  const { data: apps, isLoading, isError } = useWebxdcApps(relays);
  const { data: followList } = useFollowList();

  const follows = useMemo(() => new Set(followList?.pubkeys ?? []), [followList]);
  const canFilterFollows = follows.size > 0;

  const filtered = useMemo(() => {
    let list = apps ?? [];
    if (followsOnly && canFilterFollows) list = list.filter((a) => follows.has(a.author));
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((a) => a.name.toLowerCase().includes(q));
    return list;
  }, [apps, query, followsOnly, canFilterFollows, follows]);

  return (
    <div className="flex flex-col w-full h-[360px] max-h-[55dvh] bg-popover rounded-lg overflow-hidden">
      {/* Search + follows filter */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search games"
            className="pl-8 h-9 text-base md:text-sm bg-muted/50 border-0 rounded-lg"
          />
        </div>
        <button
          type="button"
          onClick={() => setFollowsOnly((v) => !v)}
          disabled={!canFilterFollows}
          title={canFilterFollows ? "Only games from people you follow" : "Follow people to filter"}
          className={cn(
            "flex items-center gap-1.5 h-9 px-3 shrink-0 rounded-lg text-sm font-medium transition-colors disabled:opacity-40",
            followsOnly && canFilterFollows
              ? "bg-primary/15 text-primary"
              : "bg-muted/50 text-muted-foreground hover:text-foreground",
          )}
        >
          <Users className="size-3.5" />
          Follows
        </button>
      </div>

      <ScrollArea className="flex-1 px-2 pb-2">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <Loader2 className="size-6 animate-spin mb-2" />
            <p className="text-sm">Finding games…</p>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <ImageOff className="size-8 mb-2 opacity-40" />
            <p className="text-sm">Couldn't load games</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground px-6 text-center">
            <Blocks className="size-8 mb-2 opacity-40" />
            <p className="text-sm">
              {followsOnly
                ? "No games from people you follow"
                : query
                  ? "No games match your search"
                  : "No games found yet"}
            </p>
            {!query && !followsOnly && (
              <p className="text-xs mt-1">Publish a .xdc as a kind-1063 event to list it here.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((app) => (
              <GameRow key={app.id} app={app} onSelect={onSelect} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
