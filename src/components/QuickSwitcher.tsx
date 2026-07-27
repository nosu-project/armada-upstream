import { useQueryClient } from "@tanstack/react-query";
import { Hash, MessageCircle, Server, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAppContext } from "@/hooks/useAppContext";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { useLiveCommunities2 } from "@/concord-v2/hooks/useCommunityList2";
import { flattenLayout, mergeLayout } from "@/lib/railLayout";
import {
  buildSwitcherEntries,
  nextChannelRoute,
  switcherLiveKeys,
  type SwitcherContext,
  type SwitcherEntries,
} from "@/lib/switcher";

const EMPTY_ENTRIES: SwitcherEntries = { spaces: [], channels: [] };

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
    () => ({ queryClient, communities: new Map(communities.map((c) => [c.community_id, c])) }),
    [queryClient, communities],
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
      <CommandInput placeholder="Where would you like to go?" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {entries.channels.length > 0 && (
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
        <CommandGroup heading="Servers">
          {entries.spaces.map((s) => (
            <CommandItem key={s.key} value={`${s.name} ${s.key}`} onSelect={() => go(s.route)}>
              <Server className="mr-2 size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{s.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
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
      </CommandList>
    </CommandDialog>
  );
}
