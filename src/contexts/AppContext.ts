import { createContext } from "react";

import { APP_RELAYS, DM_RELAYS, SEARCH_RELAYS } from "@/lib/platform";

import type { BlossomServerMetadata } from "@/lib/blossom";
import type { RailLayoutNode } from "@/lib/railLayout";
import type { ThemeConfig, ThemesConfig } from "@/themes";

export type Theme = "light" | "dark" | "system" | "custom";

/**
 * The user's NIP-65 (kind 10002) relay list plus its sync timestamp, mirroring
 * `BlossomServerMetadata`. Each relay carries the `read`/`write` markers from
 * its `r` tag (a bare `r` tag is both). Synced FROM the user's kind-10002 event
 * by NostrSync (read-only — this client never publishes kind 10002); merged
 * into the general relay pool only when `useUserRelays` is on. Ported from
 * Ditto's `RelayMetadata` / `getEffectiveRelays`.
 */
export interface RelayMetadata {
  relays: { url: string; read: boolean; write: boolean }[];
  updatedAt: number;
}

/**
 * Application configuration, persisted to localStorage by AppProvider.
 *
 * Note this holds no server list: the user's NIP-29 servers live in their kind
 * 10009 event (see `useNip29Servers`), added by the "+" flow or by joining a
 * channel. A deployment's platform relay (VITE_PLATFORM_RELAYS) is
 * infrastructure, not an auto-joined community — it enters the rail the same
 * way, unless an operator opts into pinning it (VITE_PIN_PLATFORM_RELAYS).
 */
export interface AppConfig {
  /** Display theme mode. */
  theme: Theme;
  /**
   * Custom theme colors, used when `theme === "custom"` (set by named
   * presets or the in-app theme builder).
   */
  customTheme?: ThemeConfig;
  /**
   * Optional per-mode overrides for the builtin light/dark themes. When set,
   * these replace the builtin core colors for the respective mode.
   */
  themes?: ThemesConfig;
  /**
   * NOTE: there is deliberately NO `addedRelays` here. The user's NIP-29
   * server set lives in exactly one place — their kind 10009 event, read via
   * `useUserGroupList()` and cached offline in the folded IndexedDB store.
   * A second copy in AppConfig was a synced field hydrated by UNION from both
   * the 10009 list and the settings blob itself, so any device holding a
   * pre-removal copy re-added a removed server forever, and the local
   * tombstone hack that vetoed it got cleared by the very event that
   * resurrected it. One source of truth removes the whole failure mode.
   */
  /**
   * User-defined display order for the *entire* community rail as one list —
   * NIP-29 servers and Concord (V1/V2) communities intermixed in any order.
   * Entries are stable rail keys: a relay URL for NIP-29 servers,
   * `c1:${communityId}` for Concord V1, `c2:${communityId}` for Concord V2.
   * Any item not listed falls back to its default position (appended in
   * discovery order). Stored locally in app config.
   */
  railOrder: string[];
  /**
   * The community rail's structured layout: an ordered list of items (by
   * stable rail key — relay URLs and `c1:`/`c2:` community keys) and
   * Discord-style folders grouping them. Supersedes `railOrder` (which is
   * still written as the flattened order for backward compatibility, and read
   * only to seed this layout on first migration). Synced across devices via
   * the encrypted settings event.
   */
  railLayout: RailLayoutNode[];
  /**
   * Ids of rail folders currently expanded. Per-device UI state (like
   * Discord, folder open/closed state does not sync).
   */
  railOpenFolders: string[];
  /**
   * App relays for non-NIP-29 traffic (kind 0 profiles, kind 10009 lists,
   * etc.) — Ditto's "app relays" concept. Seeded from VITE_APP_RELAYS
   * (default: relay.ditto.pub + relay.dreamith.to); user-editable.
   * Group-scoped events never route here.
   */
  appRelays: string[];
  /**
   * Search relays for NIP-50 queries (`search` filters: profile/mention
   * autocomplete, etc.). Ditto hardcodes these (DITTO_RELAYS); here they are
   * user-editable. Seeded from VITE_SEARCH_RELAYS. When empty, search falls
   * back to the app relays.
   */
  searchRelays: string[];
  /**
   * Whether the app relays (`appRelays`) are used in the general relay pool.
   * On by default. Turning it off is a deliberate foot-gun: with no app
   * relays, no joined servers, and no NIP-65 relays enabled, the pool is empty
   * and account data (profile, lists, emoji packs) can't load or sync, and
   * this client can't even read the kind-10002 that populates `relayMetadata`.
   * The platform-pinned relays (`PLATFORM_RELAYS`) and joined NIP-29 servers
   * are NOT gated by this, so an air-gapped deployment still works with it off.
   */
  useAppRelays: boolean;
  /**
   * Whether to include the user's own NIP-65 (kind 10002) relays in the
   * general relay pool (reads via `reqRouter`, writes via `eventRouter`), on
   * top of the app relays and joined servers. Off by default, mirroring
   * Ditto's `useUserRelays`.
   */
  useUserRelays: boolean;
  /**
   * The user's NIP-65 relay list, synced FROM their kind-10002 event by
   * NostrSync. Read-only mirror — this client never publishes kind 10002, so
   * enabling `useUserRelays` only ever ADDS the relays the user already
   * declared elsewhere. Empty until synced; an empty/failed read never clears
   * it (same non-destructive rule as `blossomServerMetadata`).
   */
  relayMetadata: RelayMetadata;
  /**
   * Whether to include the app's default DM relays (`appRelays` ∪ the platform
   * `DM_RELAYS`) in the direct-message relay set. On by default. Independent of
   * `useOwnDmRelays`: the two toggles combine (app / mine / both / neither) —
   * see `effectiveDmRelays`.
   */
  useAppDmRelays: boolean;
  /**
   * Whether to include the user's own DM relays (`dmRelays`) in the
   * direct-message relay set. Off by default. Combines with `useAppDmRelays`.
   */
  useOwnDmRelays: boolean;
  /**
   * The user's own direct-message relays — ONLY their personal relays, never
   * the app defaults (those come from `useAppDmRelays`). Used when
   * `useOwnDmRelays` is on. Empty by default.
   */
  dmRelays: string[];
  /**
   * The user's personal Blossom file server list (BUD-03), mirroring Ditto's
   * blossomServerMetadata. `servers` is synced bidirectionally with the
   * user's kind 10063 event (NostrSync pulls newer lists; Settings edits
   * publish). App default servers (APP_BLOSSOM_SERVERS) are managed
   * separately.
   */
  blossomServerMetadata: BlossomServerMetadata;
  /**
   * Whether to use the app default Blossom servers in addition to the user's
   * kind 10063 servers. Mirrors Ditto's useAppBlossomServers (and the
   * useOwnDmRelays toggle pattern). On by default.
   */
  useAppBlossomServers: boolean;
  /**
   * The last channel/room the user had open in each server/community, so we
   * can re-open it on return instead of dumping them on a channel list. Keyed
   * by `relayUrl` (NIP-29 servers, value = groupId) and by `c:${communityId}`
   * (Concord communities, value = channel id hex). Falls back to a "general"
   * channel or the first channel when there's no record.
   */
  lastChannelByServer: Record<string, string>;
  /**
   * Muted communities, by stable rail key: a relay URL for NIP-29 servers,
   * `c1:${communityId}` for Concord V1, `c2:${communityId}` for Concord V2.
   * Muting silences all notifications from every room in the community
   * (push, native background service) and suppresses its unread badge —
   * without leaving. Synced across devices.
   */
  mutedCommunities: string[];
  /**
   * Muted individual channels/rooms, by stable conversation key
   * (`${relayUrl}::${groupId}` for NIP-29 channels — the same key scheme as
   * the read state). Same effect as a community mute, scoped to one room.
   * Synced across devices.
   */
  mutedChannels: string[];
  /**
   * Discord-style per-conversation notification level, keyed by the SAME stable
   * scope keys as the mute sets:
   *   - community: a normalized relay URL (NIP-29) or `c1:`/`c2:${communityId}`
   *   - NIP-29 channel: `${relayUrl}::${groupId}`
   *   - Concord channel: `c1:`/`c2:${communityId}::${channelIdHex}`
   *   - DM: `dm:${pubkey}`
   *
   * Levels:
   *   - `all`      — notify on every message
   *   - `mentions` — notify only on @-mentions (and DMs, which are inherently
   *                  directed at you)
   *   - `nothing`  — silence completely, mentions included (this is what the
   *                  legacy mute sets migrate to)
   *
   * A conversation with NO entry inherits: a channel falls back to its
   * community's level, and a community with no level falls back to the
   * account-global per-type prefs. Supersedes `mutedCommunities`/`mutedChannels`
   * (still written for backward compatibility with older clients / the relay
   * push gateway's `muted_groups`). Synced across devices.
   */
  notifLevels: Record<string, "all" | "mentions" | "nothing">;
  /**
   * Per-conversation DM encryption preference, keyed by `dm:${pubkey}` (the
   * same scope key as `notifLevels`). Lets the user override the automatic
   * transport choice for a specific peer:
   *   - `auto`  — the default: prefer private NIP-17 (gift-wrapped kind 14),
   *               falling back to legacy NIP-04 only on explicit opt-in.
   *   - `nip17` — always send private (NIP-17). If the peer hasn't published a
   *               kind-10050 inbox the wrap is still delivered best-effort to
   *               shared relays (fully encrypted, no metadata leak).
   *   - `nip04` — always send legacy kind-4. A privacy downgrade (leaks who's
   *               talking and when), chosen deliberately (e.g. for a peer whose
   *               client only reads NIP-04).
   * A peer with no entry is `auto`. Synced across devices.
   */
  dmProtocol: Record<string, "auto" | "nip17" | "nip04">;
  /**
   * Whether to send and show typing indicators in direct messages (kind-23311
   * rumors in ephemeral kind-21059 wraps — see `useDmTyping`). ON by default.
   * Worth knowing what it costs: a signal every few seconds tells the relays
   * that this conversation is live RIGHT NOW, which the ordinary DM flow
   * (batched, and backdated up to two days by NIP-59) does not reveal. Turn it
   * off to get that back. Reciprocal in the Signal sense by construction —
   * turning it off stops our own signals AND tears down the subscription, so
   * we neither send nor see them.
   *
   * Applies to every login that can do NIP-44, remote signers included.
   * Synced across devices.
   */
  dmTypingIndicators: boolean;
  /**
   * Pinned direct-message conversations, as hex pubkeys. Pinned conversations
   * render in their own section above the rest of the DM list, still sorted
   * newest-message-first within that section — this is a SET, and its array
   * order (pins appended as they're made) carries no display meaning. Raw
   * pubkeys, not `dm:`-scoped keys: this list holds nothing but DM peers.
   * Synced across devices.
   */
  pinnedDms: string[];
  /**
   * Bluetooth-mesh incognito mode. When on (the default), this device announces
   * a derived `anon<peerid>` nickname over the mesh rather than the user's
   * Armada display name — matching bitchat's anonymous-by-default behavior.
   * Toggling it off announces the real display name. Persisted per-device.
   */
  meshIncognito: boolean;
  /**
   * Whether Bluetooth mesh chat is turned on. OFF by default — starting the
   * mesh prompts for Bluetooth permissions and runs a foreground service with
   * a persistent notification, which must never happen without the user asking
   * for it. Enabled from the Mesh page; persisted per-device.
   */
  meshEnabled: boolean;
  /**
   * Preselected zap amount (sats) in the zap dialog. Synced across devices —
   * it's a preference, not a secret (wallet connections, by contrast, stay
   * strictly local; see WalletProvider).
   */
  defaultZapAmount: number;
  /**
   * Default payment method for zaps: 'lightning' or 'bitcoin'. When both are
   * available, the zap dialog opens to this method. Synced across devices.
   */
  defaultZapMethod: 'lightning' | 'bitcoin';
  /**
   * Whether zap/wallet/financial features are enabled in the UI. When off,
   * all zap buttons, the wallet dialog, and the wallet settings section are
   * hidden. Synced across devices so a deployment-wide preference propagates.
   */
  zapsEnabled: boolean;
}

export interface AppContextType {
  config: AppConfig;
  /** Merge a partial config and persist. */
  updateConfig: (updater: (current: AppConfig) => AppConfig) => void;
}

/**
 * AppConfig fields that sync across devices via the encrypted NIP-78 settings
 * event. Everything here is cross-device meaningful; `meshEnabled` and
 * `meshIncognito` are deliberately excluded — they gate a per-device Bluetooth
 * foreground service and must never be flipped on remotely.
 * `lastChannelByServer` is excluded too: which channel you're viewing is
 * per-device navigation state — syncing it makes two open clients yank each
 * other's channel selection around.
 */
export const SYNCED_CONFIG_KEYS = [
  "theme",
  "customTheme",
  "themes",
  "railOrder",
  "railLayout",
  "appRelays",
  "searchRelays",
  "useAppRelays",
  "useUserRelays",
  "relayMetadata",
  "useAppDmRelays",
  "useOwnDmRelays",
  "dmRelays",
  "blossomServerMetadata",
  "useAppBlossomServers",
  "mutedCommunities",
  "mutedChannels",
  "notifLevels",
  "dmProtocol",
  "dmTypingIndicators",
  "pinnedDms",
  "defaultZapAmount",
  "defaultZapMethod",
  "zapsEnabled",
] as const satisfies ReadonlyArray<keyof AppConfig>;

export type SyncedConfigKey = (typeof SYNCED_CONFIG_KEYS)[number];

export const defaultConfig: AppConfig = {
  theme: "dark",
  railOrder: [],
  railLayout: [],
  railOpenFolders: [],
  appRelays: [...APP_RELAYS],
  searchRelays: [...SEARCH_RELAYS],
  useAppRelays: true,
  useUserRelays: false,
  relayMetadata: { relays: [], updatedAt: 0 },
  useAppDmRelays: true,
  useOwnDmRelays: false,
  dmRelays: [],
  blossomServerMetadata: { servers: [], updatedAt: 0 },
  useAppBlossomServers: true,
  lastChannelByServer: {},
  mutedCommunities: [],
  mutedChannels: [],
  notifLevels: {},
  dmProtocol: {},
  dmTypingIndicators: true,
  pinnedDms: [],
  meshIncognito: true,
  meshEnabled: false,
  defaultZapAmount: 100,
  defaultZapMethod: "lightning",
  zapsEnabled: true,
};

export const AppContext = createContext<AppContextType | undefined>(undefined);

/**
 * The relays direct messages read from and write to — the union of the two
 * independently-toggleable sources:
 *
 *   - app DM relays (`useAppDmRelays`): the general app relays plus the
 *     platform default DM relay(s) (`DM_RELAYS`). The app relays keep legacy
 *     NIP-04 (kind 4) DMs working; `DM_RELAYS` gives gift-wrapped (NIP-17) DMs
 *     a dependable home the push/native watch sets follow.
 *   - the user's own DM relays (`useOwnDmRelays` + `dmRelays`).
 *
 * Both on ⇒ both sets; one on ⇒ that set; neither ⇒ empty (the user has opted
 * out of DMs entirely — the settings UI warns about this).
 *
 * This is a CLIENT-SIDE helper only. The app DM relays are never written into
 * the user's published kind-10050 inbox (that event holds only the user's own
 * relays); they're just where this client also reads/writes DMs and points the
 * push/native watch sets. Because an Armada sender publishes the recipient's
 * gift wrap to its own effective set too (see useDm17), Armada↔Armada delivery
 * and push work over the shared app relays without touching anyone's 10050.
 */
export function effectiveDmRelays(config: AppConfig): string[] {
  const out = new Set<string>();
  if (config.useAppDmRelays) {
    for (const url of config.appRelays) out.add(url);
    for (const url of DM_RELAYS) out.add(url);
  }
  if (config.useOwnDmRelays) {
    for (const url of config.dmRelays) out.add(url);
  }
  return [...out];
}

/**
 * The user's own NIP-65 read relays to fold into the general pool's REQ
 * routing, or none when `useUserRelays` is off. Ported from Ditto's
 * `getEffectiveRelays` (the `useUserRelays` half); the app relays are added
 * separately and always, so this returns ONLY the user's personal read relays.
 */
export function userReadRelays(config: AppConfig): string[] {
  if (!config.useUserRelays) return [];
  return config.relayMetadata.relays.filter((r) => r.read).map((r) => r.url);
}

/**
 * The user's own NIP-65 write relays to fold into the general pool's EVENT
 * routing, or none when `useUserRelays` is off. Companion to
 * `userReadRelays` — see there.
 */
export function userWriteRelays(config: AppConfig): string[] {
  if (!config.useUserRelays) return [];
  return config.relayMetadata.relays.filter((r) => r.write).map((r) => r.url);
}
