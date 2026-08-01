import { Check, FileText, Hash, Image as ImageIcon, Link as LinkIcon, Loader2, Lock, Search, SlidersHorizontal, Video, X } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { activeFacetCount, type SearchFilters2, type SearchMedia2 } from "@/concord-v2/lib/search";
import { cn } from "@/lib/utils";

import type { ChatMsg } from "@/components/chat/transport";
import type { ChannelV2 } from "@/concord-v2/lib/types";

// ── Media facet ────────────────────────────────────────────────────────────

const MEDIA_OPTIONS: Array<{ value: SearchMedia2; label: string; icon?: typeof ImageIcon }> = [
  { value: "all", label: "All" },
  { value: "images", label: "Images", icon: ImageIcon },
  { value: "videos", label: "Videos", icon: Video },
  { value: "links", label: "Links", icon: LinkIcon },
  { value: "none", label: "Text", icon: FileText },
];

function MediaToggle({ media, onChange }: { media: SearchMedia2; onChange: (m: SearchMedia2) => void }) {
  return (
    <ToggleGroup
      type="single"
      value={media}
      onValueChange={(v) => onChange((v || "all") as SearchMedia2)}
      className="flex flex-wrap justify-start gap-1"
    >
      {MEDIA_OPTIONS.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="h-8 gap-1 px-2 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {o.icon && <o.icon className="size-3.5" />}
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// ── Author facet ─────────────────────────────────────────────────────────────

function AuthorChip({ pubkey, onRemove }: { pubkey: string; onRemove: () => void }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 py-0.5 pl-1 pr-1.5 text-xs text-foreground">
      <Avatar className="size-4">
        <AvatarImage src={author.data?.metadata?.picture} />
        <AvatarFallback className="text-[8px]">{(name || pubkey).slice(0, 2)}</AvatarFallback>
      </Avatar>
      <span className="max-w-28 truncate">
        {name ? <DisplayName pubkey={pubkey} name={name} /> : pubkey.slice(0, 8)}
      </span>
      <button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className="text-muted-foreground hover:text-foreground">
        <X className="size-3" />
      </button>
    </span>
  );
}

function AuthorOption({
  pubkey,
  query,
  selected,
  onToggle,
}: {
  pubkey: string;
  query: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  // Filter by resolved name (falls back to pubkey prefix) — names resolve
  // async, so each row self-hides rather than filtering a precomputed list.
  if (query && !name.toLowerCase().includes(query) && !pubkey.toLowerCase().startsWith(query)) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-foreground/5"
    >
      <Avatar className="size-6">
        <AvatarImage src={author.data?.metadata?.picture} />
        <AvatarFallback className="text-[9px]">{(name || pubkey).slice(0, 2)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        {name ? <DisplayName pubkey={pubkey} name={name} /> : pubkey.slice(0, 12)}
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );
}

function AuthorFacet({
  members,
  selected,
  onToggle,
}: {
  members: string[];
  selected: string[];
  onToggle: (pubkey: string) => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((pk) => (
            <AuthorChip key={pk} pubkey={pk} onRemove={() => onToggle(pk)} />
          ))}
        </div>
      )}
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter people…"
        className="h-8"
      />
      <div className="-mx-1 max-h-40 space-y-0.5 overflow-y-auto px-1">
        {members.map((pk) => (
          <AuthorOption
            key={pk}
            pubkey={pk}
            query={query}
            selected={selected.includes(pk)}
            onToggle={() => onToggle(pk)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Channel facet ────────────────────────────────────────────────────────────

function ChannelFacet({
  channels,
  selected,
  onToggle,
  onClear,
}: {
  channels: ChannelV2[];
  selected: string[];
  onToggle: (idHex: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>Channels</Label>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            All
          </button>
        )}
      </div>
      <div className="-mx-1 max-h-40 space-y-0.5 overflow-y-auto px-1">
        {channels.map((c) => (
          <label
            key={c.idHex}
            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-foreground/5"
          >
            <Checkbox checked={selected.includes(c.idHex)} onCheckedChange={() => onToggle(c.idHex)} />
            {c.isPrivate ? (
              <Lock className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Hash className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {selected.length === 0 ? "Searching all channels" : `${selected.length} selected`}
      </p>
    </div>
  );
}

// ── Filter popover (the in-bar … / sliders button) ───────────────────────────

/**
 * The structured-filter popover for the search bar: media facet, author
 * allow-list (community members), and a channel allow-list. Mirrors Ditto's
 * filter popover — one structured object edited by discrete controls. A dot on
 * the trigger signals active facets.
 */
export function SearchFiltersPopover({
  channels,
  members,
  filters,
  onChange,
}: {
  channels: ChannelV2[];
  members: string[];
  filters: SearchFilters2;
  onChange: (filters: SearchFilters2) => void;
}) {
  const count = activeFacetCount(filters);
  const set = (patch: Partial<SearchFilters2>) => onChange({ ...filters, ...patch });
  const toggleAuthor = (pk: string) =>
    set({
      authors: filters.authors.includes(pk)
        ? filters.authors.filter((a) => a !== pk)
        : [...filters.authors, pk],
    });
  const toggleChannel = (id: string) =>
    set({
      channelIds: filters.channelIds.includes(id)
        ? filters.channelIds.filter((c) => c !== id)
        : [...filters.channelIds, id],
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search filters"
          className={cn(
            "relative size-8 touch:size-10 shrink-0 text-muted-foreground",
            count > 0 && "text-foreground",
          )}
        >
          <SlidersHorizontal className="size-4" />
          {count > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4 p-3">
        <div className="space-y-1.5">
          <Label>Media</Label>
          <MediaToggle media={filters.media} onChange={(m) => set({ media: m })} />
        </div>
        <div className="space-y-1.5">
          <Label>From</Label>
          <AuthorFacet members={members} selected={filters.authors} onToggle={toggleAuthor} />
        </div>
        <ChannelFacet
          channels={channels}
          selected={filters.channelIds}
          onToggle={toggleChannel}
          onClear={() => set({ channelIds: [] })}
        />
      </PopoverContent>
    </Popover>
  );
}

// ── Results ──────────────────────────────────────────────────────────────────

/** A read-only search-result row (unsigned rumor → "View event JSON" menu),
 *  clickable to jump to the message in its channel, with matches highlighted. */
const SearchRow = memo(function SearchRow({
  event,
  highlight,
  onJump,
}: {
  event: ChatMsg;
  highlight?: string;
  onJump?: () => void;
}) {
  // `ChatMsg` is already signature-less, so the message IS the rumor.
  const rumor = event;
  return (
    <div
      role={onJump ? "button" : undefined}
      tabIndex={onJump ? 0 : undefined}
      onClick={onJump}
      onKeyDown={
        onJump
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump();
              }
            }
          : undefined
      }
      className={cn("clip-corner-lg", onJump && "cursor-pointer transition-colors hover:bg-foreground/5")}
      aria-label={onJump ? "Jump to this message" : undefined}
    >
      <ChatMessage event={event} rumor={rumor} canWrite={false} canModerate={false} highlight={highlight} />
    </div>
  );
});

/**
 * Community-wide search results: cross-channel, newest-first, each row grouped
 * under a header naming its source channel (mirrors the Mentions pane). Clicking
 * a row jumps to that message in its channel.
 */
export function SearchResultsView({
  channels,
  results,
  isLoading,
  query,
  onJump,
}: {
  channels: ChannelV2[];
  results: ChatMsg[];
  isLoading: boolean;
  query: string;
  onJump: (channelIdHex: string, messageId: string) => void;
}) {
  const nameByChannel = useMemo(() => {
    const m = new Map<string, ChannelV2>();
    for (const c of channels) m.set(c.idHex, c);
    return m;
  }, [channels]);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Search className="mb-3 size-9 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No messages found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col px-2 py-2">
      <p className="px-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground/80">
        {results.length} result{results.length === 1 ? "" : "s"}
      </p>
      {results.map((msg) => {
        const channelIdHex = msg.tags.find((t) => t[0] === "channel")?.[1] ?? "";
        const ch = nameByChannel.get(channelIdHex);
        return (
          <div key={msg.id} className="pb-1">
            <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
              {ch?.isPrivate ? <Lock className="size-3 shrink-0" /> : <Hash className="size-3 shrink-0" />}
              <span className="truncate">{ch?.name ?? "unknown channel"}</span>
            </div>
            <SearchRow
              event={msg}
              highlight={query}
              onJump={ch ? () => onJump(channelIdHex, msg.id) : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
