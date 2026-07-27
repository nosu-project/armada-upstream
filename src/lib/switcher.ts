/**
 * The transport-agnostic model behind the Discord-style quick switcher
 * (Ctrl/Cmd+K) and its Alt+↑/↓ channel hop.
 *
 * NIP-29 servers and Concord V2 communities are surfaced through one
 * {@link Transport} interface, so the palette and the keyboard cycle share a
 * single code path and gain a third transport by adding one adapter — never a
 * parallel branch in the component. The rail's flattened layout supplies the
 * ORDER (both transports already share `config.railLayout`), and each transport
 * resolves its own spaces + channels from local caches (query cache for NIP-29,
 * the decrypted IndexedDB fold for Concord) — never a network fetch, so the
 * palette opens instantly.
 */

import { matchPath } from "react-router-dom";

import { controlFoldKey } from "@/concord-v2/hooks/useControlPlane2";
import { channelsView } from "@/concord-v2/lib/community";
import { rehydrateCommunity, type CommunityListEntry } from "@/concord-v2/lib/communityList";
import type { FoldedControl } from "@/concord-v2/lib/control";
import { readFolded } from "@/lib/foldedCache";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";

import type { QueryClient } from "@tanstack/react-query";
import type { RelayInfoDocument } from "@/hooks/useRelayInfo";
import type { Nip29Group } from "@/lib/nip29";

/** A navigable space: a NIP-29 server or a Concord community. */
export interface SpaceEntry {
  /** Stable rail key: normalized relay URL (NIP-29) or `c2:<id>` (Concord). */
  key: string;
  name: string;
  route: string;
}

/** A navigable channel within some space. */
export interface ChannelEntry {
  /** Unique across the palette: `<spaceKey>::<channelId>`. */
  key: string;
  /** The channel's own id (NIP-29 group id / Concord `idHex`) — the route tail. */
  id: string;
  name: string;
  /** The parent space's display name, shown as a subtitle. */
  spaceName: string;
  route: string;
}

/** Everything the palette lists, in rail order. */
export interface SwitcherEntries {
  spaces: SpaceEntry[];
  channels: ChannelEntry[];
}

/** Ambient reads a transport needs; both come straight from hooks in the view. */
export interface SwitcherContext {
  queryClient: QueryClient;
  /** community_id → live list entry (from `useLiveCommunities2`). */
  communities: Map<string, CommunityListEntry>;
}

/**
 * One backend behind the switcher. Every method reads only local caches — no
 * network — so `channels` is async solely because Concord's fold lives in
 * IndexedDB; NIP-29 resolves synchronously and just wraps its result.
 */
interface Transport {
  /** Whether this transport owns a given rail key. */
  owns(key: string): boolean;
  /** The space for a key, or null if it isn't resolvable yet (still loading). */
  space(key: string, ctx: SwitcherContext): SpaceEntry | null;
  /** The channels in a space, ordered exactly as the space's own view shows them. */
  channels(key: string, ctx: SwitcherContext): Promise<ChannelEntry[]>;
  /** Parse a router pathname into the space key + current channel id, if it's ours. */
  match(pathname: string): { key: string; channelId?: string } | null;
}

// ── NIP-29 ───────────────────────────────────────────────────────────────────

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

const nip29Transport: Transport = {
  // A NIP-29 rail key is a bare relay URL; the Concord prefixes are not ours.
  owns: (key) => !key.startsWith("c1:") && !key.startsWith("c2:"),
  space(key, { queryClient }) {
    return { key, name: serverName(queryClient, key), route: `/s/${relayToRouteParam(key)}` };
  },
  channels(key, { queryClient }) {
    const spaceName = serverName(queryClient, key);
    return Promise.resolve(
      cachedGroups(queryClient, key).map((g) => ({
        key: `${key}::${g.id}`,
        id: g.id,
        name: g.name,
        spaceName,
        route: `/s/${relayToRouteParam(key)}/${encodeURIComponent(g.id)}`,
      })),
    );
  },
  match(pathname) {
    const m =
      matchPath<"server" | "groupId", string>("/s/:server/:groupId", pathname) ??
      matchPath<"server" | "groupId", string>("/s/:server", pathname);
    const serverParam = m?.params.server;
    if (!serverParam) return null;
    const relay = routeParamToRelay(serverParam);
    if (!relay) return null;
    return { key: relay, channelId: m?.params.groupId };
  },
};

// ── Concord V2 ─────────────────────────────────────────────────────────────

const concordKey = (id: string) => `c2:${id}`;

const concordTransport: Transport = {
  owns: (key) => key.startsWith("c2:"),
  space(key, { communities }) {
    const id = key.slice("c2:".length);
    const entry = communities.get(id);
    if (!entry) return null;
    return { key, name: entry.current.name, route: `/c/${encodeURIComponent(id)}` };
  },
  async channels(key, { communities }) {
    const id = key.slice("c2:".length);
    const entry = communities.get(id);
    if (!entry) return [];
    // Same derivation the community page uses (`useChannels2`), but sourced
    // from the persisted fold rather than a live one: rehydrate the community
    // from the list entry, read its decrypted control fold from IndexedDB, and
    // assemble the readable channels in display order. No decrypt, no network.
    const community = rehydrateCommunity(entry);
    if (!community) return [];
    const folded = await readFolded<FoldedControl>(controlFoldKey(id));
    return channelsView(community, folded).map((c) => ({
      key: `${key}::${c.idHex}`,
      id: c.idHex,
      name: c.name,
      spaceName: entry.current.name,
      route: `/c/${encodeURIComponent(id)}/${encodeURIComponent(c.idHex)}`,
    }));
  },
  match(pathname) {
    const m =
      matchPath<"communityId" | "channelId", string>("/c/:communityId/:channelId", pathname) ??
      matchPath<"communityId" | "channelId", string>("/c/:communityId", pathname);
    const communityId = m?.params.communityId;
    if (!communityId) return null;
    return { key: concordKey(communityId), channelId: m?.params.channelId };
  },
};

const TRANSPORTS: Transport[] = [nip29Transport, concordTransport];

function transportForKey(key: string): Transport | undefined {
  return TRANSPORTS.find((t) => t.owns(key));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * The live rail keys for both transports — NIP-29 relay URLs plus a `c2:<id>`
 * for every joined Concord community — to seed {@link mergeLayout}/order.
 */
export function switcherLiveKeys(
  nip29Servers: string[],
  communities: CommunityListEntry[],
): string[] {
  return [...nip29Servers, ...communities.map((c) => concordKey(c.community_id))];
}

/**
 * Snapshot the palette's spaces + channels, in rail order, across all
 * transports. `keys` is the flattened rail layout (already restricted to live
 * keys); each is dispatched to its transport. Async only because Concord reads
 * its channel fold from IndexedDB.
 */
export async function buildSwitcherEntries(
  keys: string[],
  ctx: SwitcherContext,
): Promise<SwitcherEntries> {
  const resolved = keys
    .map((key) => ({ key, transport: transportForKey(key) }))
    .filter((r): r is { key: string; transport: Transport } => Boolean(r.transport));

  const spaces = resolved
    .map(({ key, transport }) => transport.space(key, ctx))
    .filter((s): s is SpaceEntry => s !== null);

  // Promise.all preserves order, so channels stay grouped by rail position.
  const channelLists = await Promise.all(
    resolved.map(({ key, transport }) => transport.channels(key, ctx)),
  );

  return { spaces, channels: channelLists.flat() };
}

/**
 * The route for the previous/next channel (`dir` = -1/+1, wrapping) within the
 * space of the current `pathname`, or null when the path isn't a channel view
 * or the space has no loaded channels. Shared by Alt+↑/↓.
 */
export async function nextChannelRoute(
  pathname: string,
  dir: 1 | -1,
  ctx: SwitcherContext,
): Promise<string | null> {
  for (const transport of TRANSPORTS) {
    const m = transport.match(pathname);
    if (!m) continue;
    const channels = await transport.channels(m.key, ctx);
    if (channels.length === 0) return null;
    const idx = channels.findIndex((c) => c.id === m.channelId);
    const next =
      idx === -1
        ? dir === 1
          ? channels[0]
          : channels[channels.length - 1]
        : channels[(idx + dir + channels.length) % channels.length];
    return next.route;
  }
  return null;
}
