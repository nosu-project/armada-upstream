import { useQueryClient } from "@tanstack/react-query";
import { Hash, Loader2, MessageCircle, Server, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { shortTimeAgo } from "@/lib/formatTime";
import { flattenLayout, mergeLayout } from "@/lib/railLayout";
import {
  buildSwitcherEntries,
  nextChannelRoute,
  searchSwitcherMessages,
  switcherLiveKeys,
  type MessageEntry,
  type MessageScope,
  type SwitcherContext,
  type SwitcherEntries,
} from "@/lib/switcher";

const EMPTY_ENTRIES: SwitcherEntries = { spaces: [], channels: [] };

/**
 * Which result categories the palette shows. `all` shows everything; the rest
 * narrow to one category so a common word ("yo") isn't buried under every kind
 * of hit at once. `messages` is channel/community chat, `dms` direct messages.
 */
type Scope = "all" | "channels" | "servers" | "messages" | "dms";

const SCOPE_TABS: Array<{ value: Scope; label: string }> = [
  { value: "all", label: "All" },
  { value: "messages", label: "Messages" },
  { value: "dms", label: "DMs" },
  { value: "channels", label: "Channels" },
  { value: "servers", label: "Servers" },
];

/** The message corpus a scope searches, or null when it shows no messages. */
function messageScopeFor(scope: Scope): MessageScope | null {
  switch (scope) {
    case "all":
      return "all";
    case "messages":
      return "channels";
    case "dms":
      return "dms";
    default:
      return null;
  }
}

/**
 * One message search result. The author's avatar + name (and a DM partner's
 * name) resolve through the shared `useAuthor`/{@link DisplayName}, so a palette
 * row shows the same cached, emoji-aware, per-server-nicknamed identity as the
 * rest of the app. The cmdk `value` embeds the query (via the snippet) so its
 * own filter — a superset of the substring search that found the hit — always
 * keeps it, and the key makes an otherwise-identical snippet a distinct item.
 */
function MessageResult({ message, onSelect }: { message: MessageEntry; onSelect: () => void }) {
  const author = useAuthor(message.authorPubkey);
  const name = useScopedDisplayName(message.authorPubkey, author.data?.metadata);
  return (
    <CommandItem value={`${message.content} ${message.key}`} onSelect={onSelect}>
      <Avatar className="mr-2 size-7 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} alt={name} />
        <AvatarFallback className="text-xs">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{message.content}</span>
        <span className="truncate text-xs text-muted-foreground">
          <DisplayName pubkey={message.authorPubkey} name={name} />
          {" · "}
          {message.peerPubkey ? (
            <>
              Direct message · <DisplayName pubkey={message.peerPubkey} />
            </>
          ) : (
            message.source
          )}
          {" · "}
          {shortTimeAgo(message.createdAt)}
        </span>
      </div>
    </CommandItem>
  );
}

/**
 * Discord-style quick switcher (Ctrl/Cmd+K): jump to any server or community,
 * any channel the app has loaded, DMs or settings from one fuzzy-searchable
 * palette. Also owns Alt+↑/↓ — hop to the previous/next channel of the current
 * space. Both NIP-29 servers and Concord communities are surfaced through the
 * shared {@link buildSwitcherEntries} model, so nothing is transport-specific
 * here.
 *
 * Mounted once in {@link MainLayout} so the shortcuts work everywhere.
 */
export function QuickSwitcher() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { user } = useCurrentUser();
  const { config } = useAppContext();

  const liveServers = useNip29Servers();
  const communities = useLiveCommunities2();

  // Rail-ordered keys across both transports: the same construction the
  // ServerRail uses (NIP-29 relay URLs + `c2:<id>` community keys, arranged by
  // the saved layout with folders flattened in place), so the palette lists
  // spaces in the order the rail shows them. `mergeLayout` appends any live key
  // the layout doesn't know; the filter drops keys for spaces since removed.
  const orderedKeys = useMemo(() => {
    const liveKeys = switcherLiveKeys(liveServers, communities);
    const live = new Set(liveKeys);
    return flattenLayout(mergeLayout(config.railLayout, config.railOrder, liveKeys)).filter((key) =>
      live.has(key),
    );
  }, [liveServers, communities, config.railLayout, config.railOrder]);

  const ctx = useMemo<SwitcherContext>(
    () => ({
      queryClient,
      eventStore,
      communities: new Map(communities.map((c) => [c.community_id, c])),
      self: user?.pubkey,
    }),
    [queryClient, eventStore, communities, user?.pubkey],
  );
  // Keep the keydown listener stable while always seeing the freshest context.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Snapshot the palette entries when it opens (local reads aren't reactive,
  // and they don't need to be for the lifetime of one palette). Async only
  // because Concord channels come from the IndexedDB fold.
  const [entries, setEntries] = useState<SwitcherEntries>(EMPTY_ENTRIES);
  useEffect(() => {
    if (!open) {
      setEntries(EMPTY_ENTRIES);
      return;
    }
    let live = true;
    void buildSwitcherEntries(orderedKeys, ctx).then((e) => {
      if (live) setEntries(e);
    });
    return () => {
      live = false;
    };
  }, [open, orderedKeys, ctx]);

  // Message search is query-DRIVEN (there are too many messages to preload like
  // spaces/channels): debounce the typed query and scan the on-device stores.
  // Reset when the palette closes so a reopen starts clean.
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setScope("all");
    }
  }, [open]);
  useEffect(() => {
    const needle = query.trim();
    const searchScope = messageScopeFor(scope);
    if (!open || !needle || !searchScope) {
      setMessages([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let live = true;
    const handle = setTimeout(() => {
      void searchSwitcherMessages(needle, entries.channels, ctx, { scope: searchScope }).then(
        (m) => {
          if (live) {
            setMessages(m);
            setSearching(false);
          }
        },
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [open, query, scope, entries.channels, ctx]);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  // Global shortcuts: Ctrl/Cmd+K toggles the palette; Alt+↑/↓ hops channels
  // within the current space (wrapping, Discord-style).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const path = location.pathname;
        if (!path.startsWith("/s/") && !path.startsWith("/c/")) return;
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        void nextChannelRoute(path, dir, ctxRef.current).then((to) => {
          if (to) navigate(to);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [location.pathname, navigate]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Where would you like to go?" onValueChange={setQuery} />
      {/* Scope tabs. Keep the input focused on click (mousedown default is what
          moves focus) so the user can keep typing after narrowing. */}
      <div
        className="flex flex-wrap gap-1 border-b px-2 py-1.5"
        onMouseDown={(e) => e.preventDefault()}
      >
        <ToggleGroup
          type="single"
          value={scope}
          onValueChange={(v) => setScope((v || "all") as Scope)}
          className="flex flex-wrap justify-start gap-1"
        >
          {SCOPE_TABS.map((t) => (
            <ToggleGroupItem
              key={t.value}
              value={t.value}
              className="h-7 px-2 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              {t.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <CommandList>
        {/* While a message search is in flight, hold the empty state back (an
            in-flight search isn't "no results") and show a spinner instead. */}
        {!searching && <CommandEmpty>No results found.</CommandEmpty>}
        {searching && messages.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Searching messages…
          </div>
        )}
        {(scope === "all" || scope === "channels") && entries.channels.length > 0 && (
          <CommandGroup heading="Channels">
            {entries.channels.map((c) => (
              <CommandItem
                key={c.key}
                value={`${c.name} ${c.spaceName} ${c.id}`}
                onSelect={() => go(c.route)}
              >
                <Hash className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{c.name}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">{c.spaceName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {messages.length > 0 && (
          <CommandGroup heading={scope === "dms" ? "Direct messages" : "Messages"}>
            {messages.map((m) => (
              <MessageResult key={m.key} message={m} onSelect={() => go(m.route)} />
            ))}
          </CommandGroup>
        )}
        {(scope === "all" || scope === "servers") && entries.spaces.length > 0 && (
          <CommandGroup heading="Servers">
            {entries.spaces.map((s) => (
              <CommandItem key={s.key} value={`${s.name} ${s.key}`} onSelect={() => go(s.route)}>
                <Server className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{s.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {scope === "all" && (
          <CommandGroup heading="Go to">
            <CommandItem value="direct messages dms" onSelect={() => go("/dms")}>
              <MessageCircle className="mr-2 size-4 shrink-0 text-muted-foreground" />
              Direct messages
            </CommandItem>
            <CommandItem value="settings preferences" onSelect={() => go("/settings")}>
              <Settings className="mr-2 size-4 shrink-0 text-muted-foreground" />
              Settings
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
