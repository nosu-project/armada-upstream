import { useQueryClient } from "@tanstack/react-query";
import { Hash, MessageCircle, Server, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAppContext } from "@/hooks/useAppContext";
import {
  normalizeRelayUrl,
  PINNED_RAIL_RELAYS,
  relayToRouteParam,
  routeParamToRelay,
} from "@/lib/platform";
import { flattenLayout, mergeLayout } from "@/lib/railLayout";

import type { QueryClient } from "@tanstack/react-query";
import type { RelayInfoDocument } from "@/hooks/useRelayInfo";
import type { Nip29Group } from "@/lib/nip29";

/**
 * Resolve a server's display name from whatever is already known — the NIP-11
 * query cache, then the localStorage last-known-good doc — falling back to the
 * bare host. Never triggers a fetch; the switcher must open instantly.
 */
function serverName(queryClient: QueryClient, relayUrl: string): string {
  const cached = queryClient.getQueryData<RelayInfoDocument>(["relay-info", relayUrl]);
  if (cached?.name) return cached.name;
  try {
    const raw = localStorage.getItem(`armada:relay-info:${relayUrl}`);
    if (raw) {
      const parsed = JSON.parse(raw) as RelayInfoDocument;
      if (parsed?.name) return parsed.name;
    }
  } catch {
    // Unparseable cache — fall through to the host.
  }
  return relayUrl.replace(/^wss?:\/\//, "").replace(/\/$/, "");
}

/** Channels already loaded for a server (query cache only, no fetch). */
function cachedGroups(queryClient: QueryClient, relayUrl: string): Nip29Group[] {
  return queryClient.getQueryData<Nip29Group[]>(["nip29", "groups", relayUrl]) ?? [];
}

/**
 * Discord-style quick switcher (Ctrl/Cmd+K): jump to any server, any channel
 * the app has loaded, DMs or settings from one fuzzy-searchable palette. Also
 * owns Alt+↑/↓ — hop to the previous/next channel of the current server.
 *
 * Mounted once in {@link MainLayout} so the shortcuts work everywhere.
 */
export function QuickSwitcher() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { config } = useAppContext();

  // Rail-ordered server list: the same construction as ServerRail (any opt-in
  // pinned relays + user-added, normalized and de-duplicated), arranged by the
  // rail's saved layout with folders flattened in place, so the palette lists
  // servers in the order the rail shows them.
  const servers = useMemo(() => {
    const live = new Set<string>();
    for (const url of [...PINNED_RAIL_RELAYS, ...config.addedRelays]) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) live.add(normalized);
    }
    // `mergeLayout` appends every live key the layout doesn't know, so nothing
    // is lost; the filter drops Concord communities (the palette is NIP-29
    // only) and any key for a server since removed.
    const keys = flattenLayout(mergeLayout(config.railLayout, config.railOrder, [...live]));
    return keys.filter((key) => live.has(key));
  }, [config.addedRelays, config.railLayout, config.railOrder]);

  // Snapshot the palette entries when it opens (cache reads aren't reactive,
  // and they don't need to be for the lifetime of one palette).
  const entries = useMemo(() => {
    if (!open) return { servers: [] as Array<{ url: string; name: string }>, channels: [] as Array<{ relay: string; id: string; name: string; server: string }> };
    const serverEntries = servers.map((url) => ({ url, name: serverName(queryClient, url) }));
    const channelEntries = serverEntries.flatMap((s) =>
      cachedGroups(queryClient, s.url).map((g) => ({
        relay: s.url,
        id: g.id,
        name: g.name,
        server: s.name,
      })),
    );
    return { servers: serverEntries, channels: channelEntries };
  }, [open, servers, queryClient]);

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  // Global shortcuts: Ctrl/Cmd+K toggles the palette; Alt+↑/↓ hops channels
  // within the current server (wrapping, Discord-style).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const match =
          matchPath<"server" | "groupId", string>("/s/:server/:groupId", location.pathname) ??
          matchPath<"server" | "groupId", string>("/s/:server", location.pathname);
        const serverParam = match?.params.server;
        if (!serverParam) return;
        const relayUrl = routeParamToRelay(serverParam);
        if (!relayUrl) return;
        const groups = cachedGroups(queryClient, relayUrl);
        if (groups.length === 0) return;
        e.preventDefault();
        const currentId = match?.params.groupId;
        const idx = groups.findIndex((g) => g.id === currentId);
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next =
          idx === -1
            ? dir === 1
              ? groups[0]
              : groups[groups.length - 1]
            : groups[(idx + dir + groups.length) % groups.length];
        navigate(`/s/${relayToRouteParam(relayUrl)}/${encodeURIComponent(next.id)}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [location.pathname, navigate, queryClient]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Where would you like to go?" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {entries.channels.length > 0 && (
          <CommandGroup heading="Channels">
            {entries.channels.map((c) => (
              <CommandItem
                key={`${c.relay}::${c.id}`}
                value={`${c.name} ${c.server} ${c.id}`}
                onSelect={() =>
                  go(`/s/${relayToRouteParam(c.relay)}/${encodeURIComponent(c.id)}`)
                }
              >
                <Hash className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{c.name}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">{c.server}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Servers">
          {entries.servers.map((s) => (
            <CommandItem
              key={s.url}
              value={`${s.name} ${s.url}`}
              onSelect={() => go(`/s/${relayToRouteParam(s.url)}`)}
            >
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
