/**
 * The transport-agnostic model behind the Discord-style quick switcher
 * (Ctrl/Cmd+K) and its Alt+↑/↓ channel hop.
 *
 * NIP-29 servers and Concord communities are surfaced through one
 * {@link Transport} interface, so the palette and the keyboard cycle share a
 * single code path and gain a third transport by adding one adapter — never a
 * parallel branch in the component. The rail's flattened layout supplies the
 * ORDER (both transports already share `config.railLayout`), and each transport
 * resolves its own spaces + channels from local caches (query cache for NIP-29,
 * the decrypted IndexedDB fold for Concord) — never a network fetch, so the
 * palette opens instantly.
 */

import { matchPath } from "react-router-dom";
import { nip19 } from "nostr-tools";

import { channelsView } from "@/concord/lib/community";
import { rehydrateCommunity, type CommunityListEntry } from "@/concord/lib/communityList";
import { searchRumors } from "@/concord/lib/rumorStore";
import { readControlFold } from "@/concord/lib/control";
import { KIND_GROUP_CHAT } from "@/lib/nip29";
import { searchDm17Rumors } from "@/lib/nip17/dm17Store";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";

import type { QueryClient } from "@tanstack/react-query";
import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { relayInfoCache, type RelayInfoDocument } from "@/hooks/useRelayInfo";
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
  /**
   * Concord only: the owning community's id hex — which rumor-store tenant this
   * channel's messages are in. Undefined for NIP-29.
   */
  communityIdHex?: string;
  /**
   * NIP-29 only: the relay hosting this channel — which event-store tenant its
   * messages are in. The symmetric field to {@link communityIdHex}, and needed
   * for the same reason: a group id is only meaningful on its own relay, so
   * NIP-29 messages are stored per relay and a search has to say which one.
   */
  relayUrl?: string;
}

/** Everything the palette lists, in rail order. */
export interface SwitcherEntries {
  spaces: SpaceEntry[];
  channels: ChannelEntry[];
}

/** Ambient reads a transport needs; both come straight from hooks in the view. */
export interface SwitcherContext {
  queryClient: QueryClient;
  /** community_id → live list entry (from `useLiveCommunities`). */
  communities: Map<string, CommunityListEntry>;
  /** The shared app event store (NIP-29 timelines + kind-0 profiles). */
  eventStore: EventStoreContextType;
  /** The viewer's pubkey — names the DM tenant to search. Absent: no DM hits. */
  self?: string;
}

/** The event store handle carried in {@link SwitcherContext} (see useEventStore). */
type EventStoreContextType = Promise<ArmadaEventStore>;

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
 * query cache, then the persisted last-known-good doc — falling back to the
 * bare host. Never triggers a fetch, and never awaits the relay-info cache's
 * warm: the switcher must open instantly, and the host is a usable answer.
 */
function serverName(queryClient: QueryClient, relayUrl: string): string {
  const cached = queryClient.getQueryData<RelayInfoDocument>(["relay-info", relayUrl]);
  if (cached?.name) return cached.name;
  const persisted = relayInfoCache.get(relayUrl);
  if (persisted?.name) return persisted.name;
  return relayUrl.replace(/^wss?:\/\//, "").replace(/\/$/, "");
}

/** Channels already loaded for a server (query cache only, no fetch). */
function cachedGroups(queryClient: QueryClient, relayUrl: string): Nip29Group[] {
  return queryClient.getQueryData<Nip29Group[]>(["nip29", "groups", relayUrl]) ?? [];
}

const nip29Transport: Transport = {
  // A NIP-29 rail key is a bare relay URL; the Concord prefix is not ours.
  owns: (key) => !key.startsWith("c2:"),
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
        relayUrl: key,
      })),
    );
  },
  match(pathname) {
    const withGroup = matchPath("/s/:server/:groupId", pathname);
    const m = withGroup ?? matchPath("/s/:server", pathname);
    const serverParam = m?.params.server;
    if (!serverParam) return null;
    const relay = routeParamToRelay(serverParam);
    if (!relay) return null;
    return { key: relay, channelId: withGroup?.params.groupId };
  },
};

// ── Concord ─────────────────────────────────────────────────────────────

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
    // Same derivation the community page uses (`useChannels`), but sourced
    // from the persisted fold rather than a live one: rehydrate the community
    // from the list entry, read its decrypted control fold from IndexedDB, and
    // assemble the readable channels in display order. No decrypt, no network.
    const community = rehydrateCommunity(entry);
    if (!community) return [];
    const folded = await readControlFold(id);
    return channelsView(community, folded).map((c) => ({
      key: `${key}::${c.idHex}`,
      id: c.idHex,
      name: c.name,
      spaceName: entry.current.name,
      route: `/c/${encodeURIComponent(id)}/${encodeURIComponent(c.idHex)}`,
      communityIdHex: community.idHex,
    }));
  },
  match(pathname) {
    const withChannel = matchPath("/c/:communityId/:channelId", pathname);
    const m = withChannel ?? matchPath("/c/:communityId", pathname);
    const communityId = m?.params.communityId;
    if (!communityId) return null;
    return { key: concordKey(communityId), channelId: withChannel?.params.channelId };
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

// ── Message search ─────────────────────────────────────────────────────────────
//
// The palette's spaces + channels are a query-independent snapshot (cmdk fuzzy-
// filters them client-side). Messages can't work that way — there are far too
// many to preload — so message search is query-DRIVEN: the component runs this
// against the local, already-decrypted stores as the user types. Every corpus is
// on-device (Concord chat is E2E-encrypted; NIP-29 timelines and DM rumors are
// persisted at rest), so this never hits the network or prompts the signer. The
// channel routes come from the same {@link SwitcherEntries} the palette already
// built, so a hit navigates straight to its channel/DM.

/**
 * A message that matched the palette's search, resolved to its channel/DM.
 *
 * Author + DM-partner identities are carried as PUBKEYS, not resolved names:
 * the view renders them through the shared {@link DisplayName}/`useAuthor`
 * components, so message rows get the same cached, emoji-aware, per-server
 * nicknamed identity (and network fallback) as everywhere else — no bespoke
 * profile lookup here.
 */
export interface MessageEntry {
  /** Unique across the palette: `msg:<rumor/event id>`. */
  key: string;
  /** The matched message text (whitespace-collapsed for a one-line snippet). */
  content: string;
  /** Who said it (pubkey hex). The view resolves name + avatar via useAuthor. */
  authorPubkey: string;
  /** The channel/DM route to open. */
  route: string;
  /** `created_at` (seconds) — for the "when" label and newest-first ordering. */
  createdAt: number;
  /**
   * Where the match lives. Channel hits carry a ready `#channel · Space` label;
   * DM hits leave it unset and set {@link peerPubkey} so the view renders the
   * partner's live name.
   */
  source?: string;
  /** DM partner pubkey (hex), when the hit is a direct message. */
  peerPubkey?: string;
}

/** NIP-29 timeline kinds whose content is searchable (chat + NIP-88 polls). */
const NIP29_MESSAGE_KINDS = [KIND_GROUP_CHAT, 1068];
/** Newest-first store scan cap per NIP-29 search (content isn't indexed). */
const NIP29_SCAN_LIMIT = 2000;
/** Per-corpus match cap before the merged newest-first slice to `limit`. */
const PER_CORPUS_LIMIT = 40;

/** Collapse whitespace/newlines into a single-line snippet. */
function snippet(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

/** Concord chat matches, mapped back to their channel via the loaded entries. */
async function searchConcordMessages(
  needle: string,
  byId: Map<string, ChannelEntry>,
  signal?: AbortSignal,
): Promise<MessageEntry[]> {
  if (byId.size === 0) return [];

  // One search per community: each community's messages live in their own
  // rumor-store tenant, so this can't be a single scan across every channel id
  // any more. `PER_CORPUS_LIMIT` therefore caps matches per COMMUNITY rather
  // than across all of Concord — the caller's merged newest-first slice is what
  // bounds the final list either way.
  const byCommunity = new Map<string, string[]>();
  for (const ch of byId.values()) {
    if (!ch.communityIdHex) continue;
    const bucket = byCommunity.get(ch.communityIdHex);
    if (bucket) bucket.push(ch.id);
    else byCommunity.set(ch.communityIdHex, [ch.id]);
  }

  const hits = (
    await Promise.all(
      [...byCommunity].map(([communityIdHex, ids]) =>
        searchRumors(communityIdHex, ids, { query: needle, limit: PER_CORPUS_LIMIT, signal }),
      ),
    )
  ).flat();

  const out: MessageEntry[] = [];
  for (const h of hits) {
    const ch = byId.get(h.channelIdHex);
    if (!ch) continue;
    out.push({
      key: `msg:${h.rumorId}`,
      content: snippet(h.content),
      authorPubkey: h.author,
      source: `${ch.name} · ${ch.spaceName}`,
      route: ch.route,
      createdAt: h.createdAt,
    });
  }
  return out;
}

/** NIP-29 timeline matches: an indexed `#h` scan filtered by content in memory. */
async function searchNip29Messages(
  needle: string,
  byId: Map<string, ChannelEntry>,
  eventStore: EventStoreContextType,
  signal?: AbortSignal,
): Promise<MessageEntry[]> {
  if (byId.size === 0) return [];
  const store = await eventStore;

  // One scan per relay, for the same reason Concord scans per community: each
  // relay's messages live in their own tenant, because a group id is only
  // meaningful on the relay hosting it. `NIP29_SCAN_LIMIT` therefore caps the
  // scan per RELAY rather than across all of NIP-29 — the caller's merged
  // newest-first slice is what bounds the final list either way.
  const byRelay = new Map<string, string[]>();
  for (const ch of byId.values()) {
    if (!ch.relayUrl) continue;
    const bucket = byRelay.get(ch.relayUrl);
    if (bucket) bucket.push(ch.id);
    else byRelay.set(ch.relayUrl, [ch.id]);
  }

  const events = (
    await Promise.all(
      [...byRelay].map(([relay, ids]) =>
        store.query([{ kinds: NIP29_MESSAGE_KINDS, "#h": ids, limit: NIP29_SCAN_LIMIT }], {
          signal,
          relay,
        }),
      ),
    )
  ).flat();

  const out: MessageEntry[] = [];
  for (const ev of events) {
    if (!ev.content.toLowerCase().includes(needle)) continue;
    const ch = byId.get(ev.tags.find((t) => t[0] === "h")?.[1] ?? "");
    if (!ch) continue;
    out.push({
      key: `msg:${ev.id}`,
      content: snippet(ev.content),
      authorPubkey: ev.pubkey,
      source: `${ch.name} · ${ch.spaceName}`,
      route: ch.route,
      createdAt: ev.created_at,
    });
    if (out.length >= PER_CORPUS_LIMIT) break;
  }
  return out;
}

/** DM matches; the author and partner are resolved to names by the view. */
async function searchDmMessages(
  self: string,
  query: string,
  signal?: AbortSignal,
): Promise<MessageEntry[]> {
  const hits = await searchDm17Rumors(self, query, { limit: PER_CORPUS_LIMIT, signal });
  return hits.map((h) => ({
    key: `msg:${h.rumorId}`,
    content: snippet(h.content),
    authorPubkey: h.author,
    peerPubkey: h.peer,
    route: `/dm/${nip19.npubEncode(h.peer)}`,
    createdAt: h.createdAt,
  }));
}

/**
 * Which message corpora {@link searchSwitcherMessages} scans:
 *   - `all`      — channel/community chat AND DMs (the default);
 *   - `channels` — channel/community chat only (Concord + NIP-29);
 *   - `dms`      — direct messages only.
 * Narrowing runs FEWER corpora, so the whole `limit` goes to the wanted kind —
 * picking DMs surfaces DM matches even when channel chatter would bury them.
 */
export type MessageScope = "all" | "channels" | "dms";

/**
 * Search the on-device message corpora — Concord chat, NIP-29 timelines and DM
 * history — for `query`, newest-first, capped at `limit`. `channels` is the
 * palette's already-loaded channel list: it both scopes the scan (only channels
 * the app has loaded are searchable) and maps each hit back to a navigable
 * route. `scope` narrows which corpora run. Author/partner names + avatars are
 * left to the view (rendered via the shared `useAuthor`/{@link DisplayName}).
 * Returns [] for a blank query.
 */
export async function searchSwitcherMessages(
  query: string,
  channels: ChannelEntry[],
  ctx: SwitcherContext,
  opts: { limit?: number; scope?: MessageScope; signal?: AbortSignal } = {},
): Promise<MessageEntry[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const limit = opts.limit ?? 30;
  const scope = opts.scope ?? "all";
  const wantChannels = scope !== "dms";
  const wantDms = scope !== "channels";

  // Split loaded channels by transport (route prefix) and index by channel id,
  // so a matched message resolves to its channel's name + route.
  const concordById = new Map<string, ChannelEntry>();
  const nip29ById = new Map<string, ChannelEntry>();
  for (const c of channels) {
    if (c.route.startsWith("/c/")) concordById.set(c.id, c);
    else if (c.route.startsWith("/s/")) nip29ById.set(c.id, c);
  }

  const groups = await Promise.all([
    wantChannels ? searchConcordMessages(needle, concordById, opts.signal) : [],
    wantChannels ? searchNip29Messages(needle, nip29ById, ctx.eventStore, opts.signal) : [],
    wantDms && ctx.self ? searchDmMessages(ctx.self, query, opts.signal) : [],
  ]);

  return groups
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
