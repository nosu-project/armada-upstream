import { createContext } from "react";

import { STOCK_RELAYS } from "@/concord/lib/stockRelays";
import { APP_BLOSSOM_SERVERS } from "@/lib/blossom";
import { APP_RELAYS, BROADCAST_RELAYS, DM_RELAYS, normalizeRelayUrl, SEARCH_RELAYS } from "@/lib/platform";
import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/lib/pushPrefs";
import { getPreferredVoiceServer } from "@/lib/voiceDevices";

import type { BlossomServerMetadata } from "@/lib/blossom";
import type { RailLayoutNode } from "@/lib/railLayout";
import type { SendOnEnterPref } from "@/lib/sendOnEnter";
import type { ThemeConfig } from "@/themes";

export type Theme = "light" | "dark" | "system" | "custom";

/** The newest message that existed when a DM was closed from the sidebar. */
export interface ClosedDmMarker {
  eventId?: string;
  createdAt: number;
}

/**
 * How monetary amounts are displayed and entered (zap amounts, fees, totals).
 * `"usd"` converts sats to USD at the current BTC price; `"sats"` shows raw
 * satoshi amounts. Ported from Ditto, where it is what keeps the Lightning and
 * Bitcoin panes of the zap dialog denominated in the same unit.
 */
export type CurrencyDisplay = "usd" | "sats";

/**
 * The user's NIP-65 (kind 10002) relay list plus its sync timestamp, mirroring
 * `BlossomServerMetadata`. Each relay carries the `read`/`write` markers from
 * its `r` tag (a bare `r` tag is both). Synced FROM the user's kind-10002 event
 * by NostrSync; user-approved edits publish a replacement kind 10002. Merged
 * into the general relay pool only when `useUserRelays` is on. Ported from
 * Ditto's `RelayMetadata` / `getEffectiveRelays`.
 */
export interface RelayMetadata {
  relays: { url: string; read: boolean; write: boolean }[];
  updatedAt: number;
  /** Winning kind-10002 id, for NIP-01's lower-id same-second tiebreak. */
  eventId?: string;
  /** Owner of this replaceable list; absent only on pre-migration local data. */
  pubkey?: string;
}

/**
 * Application configuration, persisted to localStorage by AppProvider.
 *
 * Note this holds no server list: the user's NIP-29 servers live in their kind
 * 10009 event (see `useNip29Servers`), added by the "+" flow or by joining a
 * channel. No build-time relay is ever added on the user's behalf.
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
   * The community rail's structured layout: an ordered list of items (by
   * stable rail key — relay URLs, `c2:` community keys, `dm:` peer keys) and
   * Discord-style folders grouping them. Any item not listed falls back to its
   * default position (appended in discovery order by `mergeLayout`).
   *
   * The whole arrangement, and the ONLY field of its settings document
   * (`${APP_ID}/rail`). It superseded a flat `railOrder: string[]`, which was
   * written alongside it for a while for older clients and is now read exactly
   * once, to seed a layout that doesn't exist yet — from localStorage in
   * `deserializeConfig`, and from the legacy metadata document in
   * `settingsDocs.ts`. It is `flattenLayout(railLayout)` and nothing more, so
   * keeping it as a second stored copy only created two things that could
   * disagree.
   */
  railLayout: RailLayoutNode[];
  /**
   * Ids of rail folders currently expanded. Per-device UI state (like
   * Discord, folder open/closed state does not sync).
   */
  railOpenFolders: string[];
  /**
   * Collapsed channel categories, `communityIdHex` → casefolded category keys
   * (see `channelCategory.ts`). Per-device UI state, like `railOpenFolders`:
   * which headings you have folded away is a property of the screen you are
   * sitting at, not of the account.
   *
   * Keyed by category NAME rather than an id because categories have no ids —
   * they exist only as the set of channels naming them. Renaming a category
   * therefore un-collapses it, which is the right failure: a heading that
   * reappears is noticed and re-folded, whereas one that stays folded under a
   * name nobody recognizes is not.
   */
  collapsedChannelCategories: Record<string, string[]>;
  /**
   * Whether the desktop member-list side panel is shown in community views.
   * Tri-state: `undefined` means "use the per-device default" (shown on real
   * desktop, hidden on touch, matching `useIsTouch()`); once the user hides or
   * shows it, their explicit choice (`false`/`true`) is stored and respected on
   * every return. Per-device UI state — deliberately NOT synced: the default is
   * device-dependent, and which chrome panels you keep open is local navigation
   * state (like `railOpenFolders`). The mobile members overlay is transient and
   * not persisted.
   */
  memberListVisible?: boolean;
  /**
   * App relays for non-NIP-29 traffic (kind 0 profiles, kind 10009 lists,
   * etc.) — Ditto's "app relays" concept. Seeded from VITE_APP_RELAYS
   * (default: relay.ditto.pub + relay.dreamith.to); user-editable.
   * Group-scoped events never route here.
   */
  appRelays: string[];
  /**
   * Write-only relays. Everything the pool's `eventRouter` publishes — the
   * profile, the personal lists, general notes — is sent here as well as to
   * the app relays, but nothing is ever READ from them: they are absent from
   * `poolReadRelays`, `poolGeneralRelays`, `accountDataRelays` and the DM set,
   * so they cost nothing on load and no account data depends on them. Seeded
   * from VITE_BROADCAST_RELAYS (default: relay.primal.net); user-editable, and
   * gated off with the app relays by `useAppRelays`.
   *
   * Group-scoped and Concord traffic never routes here, for the same reason it
   * never routes to the app relays: it goes straight to its own relays.
   */
  broadcastRelays: string[];
  /**
   * The home relays a NEW Concord community is minted on — the create dialog's
   * pre-selected set, editable there per community and here as the standing
   * default. Seeded from the CORD stock set; when emptied, the create path
   * falls back to that same stock set rather than minting a homeless community.
   *
   * Deliberately SEPARATE from `appRelays`: those carry the user's own account
   * traffic (profiles, lists, settings) and have no business deciding where a
   * community lives, nor the reverse. It is equally separate from the three
   * roles `STOCK_RELAYS` plays that are NOT preferences and must stay frozen —
   * the CORD-05 fragment codec (the set `FLAG_STOCK_SET` names, shared
   * byte-for-byte with other clients), the kind-33302 vault rescue floor (whose
   * job is to work when the user's relay config doesn't), and invite
   * bootstrap/delivery fallbacks (which are about reaching other people).
   */
  communityRelays: string[];
  /**
   * Search relays for NIP-50 queries (`search` filters: profile/mention
   * autocomplete, etc.). Ditto hardcodes these (DITTO_RELAYS); here they are
   * user-editable. Seeded from VITE_SEARCH_RELAYS. When empty, search falls
   * back to the app relays.
   */
  searchRelays: string[];
  /**
   * Portable preference for the host used to start empty Concord/DM voice
   * calls. Unlike mic/speaker device ids and audio processing, this is an
   * account choice and follows the user through encrypted NIP-78 settings.
   */
  preferredVoiceServer: string;
  /**
   * Whether this installation automatically sends and applies Armada's
   * encrypted settings documents. Device-local by design: synchronizing this
   * switch would let one client turn every other client back on or off.
   * Manual "Sync now" remains available either way.
   */
  automaticSettingsSync: boolean;
  /**
   * Whether the app relays (`appRelays`) are used in the general relay pool.
   * On by default. Turning it off is a deliberate foot-gun: with no app
   * relays, no joined servers, and no NIP-65 relays enabled, the pool is empty
   * and account data (profile, lists, emoji packs) can't load or sync, and
   * this client can't even read the kind-10002 that populates `relayMetadata`.
   * The joined NIP-29 servers are NOT gated by this, so an air-gapped
   * deployment still works with it off.
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
   * The user's NIP-65 relay list, synced from their kind-10002 event by
   * NostrSync and changed only through Armada's explicit relay-list editor.
   * Empty until synced; an empty/failed read never clears it (same
   * non-destructive rule as `blossomServerMetadata`).
   */
  relayMetadata: RelayMetadata;
  /**
   * Whether to include the app's DM relays (`appRelays` ∪ `appDmRelays`) in the
   * direct-message relay set. On by default. Independent of
   * `useOwnDmRelays`: the two toggles combine (app / mine / both / neither) —
   * see `effectiveDmRelays`.
   */
  useAppDmRelays: boolean;
  /**
   * Additional app-provided DM relays. Seeded from `VITE_DM_RELAYS`, but kept
   * in encrypted settings so restoring a custom setup replaces the shipped
   * Armada address instead of silently adding it back. General `appRelays`
   * remain part of the app DM set for legacy NIP-04 interoperability.
   */
  appDmRelays: string[];
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
   * publish). App-provided servers (`appBlossomServers`) are managed separately.
   */
  blossomServerMetadata: BlossomServerMetadata;
  /**
   * Whether to use the app default Blossom servers in addition to the user's
   * kind 10063 servers. Mirrors Ditto's useAppBlossomServers (and the
   * useOwnDmRelays toggle pattern). On by default.
   */
  useAppBlossomServers: boolean;
  /**
   * App-provided Blossom servers. Like `appRelays` and `appDmRelays`, these are
   * seeded from the build only for a fresh config; a synchronized value is the
   * complete replacement set.
   */
  appBlossomServers: string[];
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
   * `c2:${communityId}` for Concord communities.
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
   *   - community: a normalized relay URL (NIP-29) or `c2:${communityId}`
   *   - NIP-29 channel: `${relayUrl}::${groupId}`
   *   - Concord channel: `c2:${communityId}::${channelIdHex}`
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
  /** Account-global notification categories, shared by every delivery path. */
  pushPrefs: PushPrefs;
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
   * Whether direct messages are turned off entirely. OFF by default (DMs on).
   * When ON, this client stops holding every STANDING direct-message
   * subscription — the wire's gift-wrap/legacy-DM filters (`buildWireSpec`),
   * the NIP-17 inbox top-up (`useDm17`), typing indicators, DM call signaling,
   * and the web-push / iOS / Android watch sets — by collapsing their DM relay
   * set to empty. That is the point: it saves the bandwidth of a live inbox and
   * opts the account out of unsolicited inbound DMs at the network level,
   * rather than merely hiding them after they arrive. It doesn't delete stored
   * conversations or unpublish the user's kind-10050 inbox. Synced across
   * devices, so the opt-out follows the account.
   */
  dmsDisabled: boolean;
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
   * DMs dismissed from the sidebar, keyed by peer pubkey. The marker identifies
   * the newest message present when the row was closed; any later/different
   * newest message makes the row visible again. Synced privately across devices.
   */
  closedDms: Record<string, ClosedDmMarker>;
  /**
   * DM peers that have been let through the request tier, as hex pubkeys. A
   * conversation with someone the user neither follows nor has written to
   * lands in "Requests" instead of the main list.
   *
   * Written only when the user replies to a request or picks a recipient in
   * the compose pane — there is no accept button, because writing to someone
   * IS accepting them (see useAcceptedDms).
   *
   * Deliberately NOT the follow list: replying to a message is not a public
   * social-graph edge, and writing kind 3 as a side effect of it would leak
   * who talks to whom. This is a private, synced preference. Sticky — it must
   * outlive an unfollow, exactly like `pinnedDms`.
   */
  acceptedDms: string[];
  /**
   * DM peers the user deliberately opened a conversation with before any
   * message exists, as hex pubkeys — currently written by the `/<user>` chat
   * link landing, where accepting the invitation IS the whole point of the
   * visit.
   *
   * The DM list is otherwise derived entirely from stored messages, so an
   * empty thread lives only as long as it's the open route. That's right for
   * an idle click-through and wrong for a link somebody sent you to talk to
   * them: navigate away once and the person you came here for is gone. This is
   * the small set of peers whose row is kept regardless. Closing the row hides
   * it the ordinary way (`closedDms`), and once a real message lands the row
   * comes from the message instead. Capped at {@link MAX_STARTED_DMS}, newest
   * kept. Synced across devices.
   */
  startedDms: string[];
  /**
   * Whether unknown-sender DMs are surfaced in the request tier. ON by default.
   * When off, conversations with people the user neither follows nor has
   * written to are hidden from the DM list entirely — the "Requests" entry
   * point never appears. Purely a display preference: it hides the pile, it
   * does not delete `acceptedDms` or drop any messages, and an explicit deep
   * link to such a peer still opens the thread. Synced across devices.
   */
  showDmRequests: boolean;
  /**
   * Whether the rail shows the automatic strip of recent unread DMs — the
   * newest unread conversations the user has NOT manually pinned to the rail,
   * capped at {@link MAX_RAIL_RECENT_DMS}. ON by default. Purely a display
   * preference for that transient strip: turning it off leaves manually
   * arranged rail DMs untouched, drops no messages, and the conversations
   * remain in the DM list. Synced across devices.
   */
  showRecentRailDms: boolean;
  /**
   * Whether Discover shows the unfiltered public firehose instead of the
   * curated author allow-list (the team follow pack, plus your own follows when
   * logged in). OFF by default. Turning it on surfaces communities, emoji packs
   * and themes from anyone on the relays, including unvetted and potentially
   * objectionable content. Synced across devices.
   */
  discoverAllContent: boolean;
  /**
   * Whether tracking parameters are stripped from links — both from what this
   * client SENDS and from what it renders and fetches. ON by default.
   *
   * A share sheet's URL usually carries a per-share identifier (YouTube's
   * `si=`), a click id (`fbclid`, `gclid`) or a campaign tag (`utm_*`), which
   * on a message published to a relay is forwarded to every reader and to
   * everything that follows the link on their behalf, the preview unfurler
   * included. Only named parameters are removed, so the link still resolves to
   * the same page — see `lib/trackingParams.ts`. Publishes nothing of its own;
   * synced across devices.
   */
     stripTrackingParams: boolean;
  /**
   * Whether pressing Enter in the message composer sends the message (with
   * Shift+Enter inserting a newline). When off, Enter inserts a newline and
   * Ctrl/Cmd+Enter sends instead.
   *
   * Keyed by device CLASS, and synced. Each class UNSET (the default) means
   * "auto" — Enter sends on a physical keyboard and inserts a newline on touch,
   * which is where the two classes' expectations are in opposition. Storing the
   * override per class rather than per device means a choice syncs to every like
   * device (all your desktops, all your phones) without a desktop preference
   * ever forcing itself onto a phone. Resolve with `sendsOnEnter()`. Does not
   * apply to document editing, which is always multi-line (Ctrl/Cmd+Enter sends
   * there regardless).
   */
  sendOnEnter?: SendOnEnterPref;
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
   * Unit every money amount is shown and entered in — zap amounts, network
   * fees, totals, the success screen. Synced across devices; it's a
   * preference, not a secret (wallet connections, by contrast, stay strictly
   * local; see WalletProvider).
   */
  currencyDisplay: CurrencyDisplay;
  /**
   * Default payment method for zaps: 'lightning' or 'bitcoin'. When both are
   * available, the zap dialog opens to this method. Defaults to 'bitcoin',
   * which every pubkey can receive (the address is derived from the key)
   * whereas Lightning needs the recipient to have configured an address.
   * Synced across devices.
   */
  defaultZapMethod: 'lightning' | 'bitcoin';
  /**
   * Whether zap/wallet/financial features are enabled in the UI. When off,
   * all zap buttons, the wallet dialog, and the wallet settings section are
   * hidden. Synced across devices so a deployment-wide preference propagates.
   */
  zapsEnabled: boolean;
  /**
   * Whether the user has opened Account Standing. Starts false, which is what
   * puts the nag dot on the settings entry; the first open sets it and the dot
   * never comes back. Synced so seeing the joke once settles it everywhere.
   */
  accountStandingSeen: boolean;
}

/**
 * How many message-less DM rows {@link AppConfig.startedDms} keeps. These rows
 * are seeded by a user action and only ever removed by closing them, so the
 * list needs a ceiling; it rides in the synced settings blob, and a person who
 * opens a lot of chat links shouldn't grow it without bound.
 */
export const MAX_STARTED_DMS = 50;

/**
 * How many automatic recent-unread DMs the {@link ServerRail} shows above the
 * arranged list — the transient strip of newest unread conversations the user
 * did NOT manually pin to the rail. The strip is recency-ordered and clears
 * itself as conversations are read, so it needs a ceiling to keep an active
 * inbox from crowding out the arranged communities below it. Gated entirely by
 * {@link AppConfig.showRecentRailDms}.
 */
export const MAX_RAIL_RECENT_DMS = 3;

export interface AppContextType {
  config: AppConfig;
  /** Merge a partial config and persist. */
  updateConfig: (updater: (current: AppConfig) => AppConfig) => void;
}

/**
 * The AppConfig fields carried by each encrypted NIP-78 settings document, one
 * list per document. See `lib/settingsDocs.ts` for the catalogue that binds
 * these to their `d` tags, and `docs/settings-documents.md` for why the split
 * exists — briefly: a field that grows without bound or is rewritten
 * constantly does not belong in the same replaceable event as the theme.
 *
 * Deliberately synced by NO document: `meshEnabled` / `meshIncognito` gate a
 * per-device Bluetooth foreground service and must never be flipped on
 * remotely; `railOpenFolders`, `collapsedChannelCategories` and
 * `memberListVisible` are per-device UI state; `lastChannelByServer` is
 * per-device navigation state, which two open clients would otherwise yank
 * back and forth; and `searchRelays` / `dmRelays` / `relayMetadata` /
 * `blossomServerMetadata` are local mirrors of canonical list events (10007 /
 * 10050 / 10002 / 10063), which own them instead.
 */

/** `${APP_ID}/metadata` — bounded preferences, written when a user changes one. */
export const METADATA_CONFIG_KEYS = [
  "theme",
  "customTheme",
  "appRelays",
  "broadcastRelays",
  "communityRelays",
  "preferredVoiceServer",
  "useAppRelays",
  "useUserRelays",
  "useAppDmRelays",
  "appDmRelays",
  "useOwnDmRelays",
  "useAppBlossomServers",
  "appBlossomServers",
  "dmTypingIndicators",
  "dmsDisabled",
  "showDmRequests",
  "showRecentRailDms",
  "discoverAllContent",
  "stripTrackingParams",
  "sendOnEnter",
  "currencyDisplay",
  "defaultZapMethod",
  "zapsEnabled",
  "accountStandingSeen",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/** `${APP_ID}/rail` — grows with every community; rewritten on every drag. */
export const RAIL_CONFIG_KEYS = ["railLayout"] as const satisfies ReadonlyArray<keyof AppConfig>;

/** `${APP_ID}/notifications` — one entry per conversation the user has tuned. */
export const NOTIF_CONFIG_KEYS = [
  "notifLevels",
  "mutedCommunities",
  "mutedChannels",
  "pushPrefs",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/** `${APP_ID}/dms` — one entry per peer, in four maps that only ever grow. */
export const DM_CONFIG_KEYS = [
  "dmProtocol",
  "pinnedDms",
  "closedDms",
  "acceptedDms",
  "startedDms",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/**
 * Every AppConfig field that syncs, across all documents. Derived rather than
 * written out, so a key can't be in a slice and missing here (or the reverse).
 */
export const SYNCED_CONFIG_KEYS = [
  ...METADATA_CONFIG_KEYS,
  ...RAIL_CONFIG_KEYS,
  ...NOTIF_CONFIG_KEYS,
  ...DM_CONFIG_KEYS,
] as const satisfies ReadonlyArray<keyof AppConfig>;

export type SyncedConfigKey = (typeof SYNCED_CONFIG_KEYS)[number];

/** Local mirrors whose standard signed list events are the portable source. */
export const CANONICAL_LIST_CONFIG_KEYS = [
  "searchRelays",
  "dmRelays",
  "relayMetadata",
  "blossomServerMetadata",
] as const satisfies ReadonlyArray<keyof AppConfig>;

/** Deliberately device-specific config, never applied from another client. */
export const PER_DEVICE_CONFIG_KEYS = [
  "automaticSettingsSync",
  "railOpenFolders",
  "collapsedChannelCategories",
  "memberListVisible",
  "lastChannelByServer",
  "meshIncognito",
  "meshEnabled",
] as const satisfies ReadonlyArray<keyof AppConfig>;

export const defaultConfig: AppConfig = {
  theme: "dark",
  railLayout: [],
  railOpenFolders: [],
  collapsedChannelCategories: {},
  appRelays: [...APP_RELAYS],
  broadcastRelays: [...BROADCAST_RELAYS],
  communityRelays: [...STOCK_RELAYS],
  searchRelays: [...SEARCH_RELAYS],
  preferredVoiceServer: getPreferredVoiceServer(),
  automaticSettingsSync: true,
  useAppRelays: true,
  useUserRelays: false,
  relayMetadata: { relays: [], updatedAt: 0 },
  useAppDmRelays: true,
  appDmRelays: [...DM_RELAYS],
  useOwnDmRelays: false,
  dmRelays: [],
  blossomServerMetadata: { servers: [], updatedAt: 0 },
  useAppBlossomServers: true,
  appBlossomServers: [...APP_BLOSSOM_SERVERS],
  lastChannelByServer: {},
  mutedCommunities: [],
  mutedChannels: [],
  notifLevels: {},
  // Account defaults must be pure. The old origin-global mirror belonged to
  // whichever account wrote it last and leaked those choices into a fresh one.
  pushPrefs: { ...DEFAULT_PUSH_PREFS },
  dmProtocol: {},
  dmTypingIndicators: true,
  dmsDisabled: false,
  pinnedDms: [],
  closedDms: {},
  acceptedDms: [],
  startedDms: [],
  showDmRequests: true,
  showRecentRailDms: true,
  discoverAllContent: false,
  stripTrackingParams: true,
  meshIncognito: true,
  meshEnabled: false,
  currencyDisplay: "usd",
  defaultZapMethod: "bitcoin",
  zapsEnabled: true,
  accountStandingSeen: false,
};

export const AppContext = createContext<AppContextType | undefined>(undefined);

/**
 * The relays direct messages read from and write to — the union of the two
 * independently-toggleable sources:
 *
 *   - app DM relays (`useAppDmRelays`): the general app relays plus the
 *     synchronized app DM relay set (`appDmRelays`). The app relays keep legacy
 *     NIP-04 (kind 4) DMs working; `DM_RELAYS` gives gift-wrapped (NIP-17) DMs
 *     a dependable home the push/native watch sets follow. A fresh config
 *     seeds that set from `DM_RELAYS`; a restored setup replaces it wholesale.
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
    for (const url of config.appDmRelays) out.add(url);
  }
  if (config.useOwnDmRelays) {
    for (const url of config.dmRelays) out.add(url);
  }
  return [...out];
}

/**
 * The write-only relays the general pool's EVENT routing publishes to on top
 * of everything else (`config.broadcastRelays`), or none when the app relays
 * are switched off.
 *
 * The ONE caller is `NostrProvider`'s `poolWriteRelays`. This is a function
 * rather than an inline fold so the invariant it exists for can be tested: the
 * result must never reach a read set — not `poolReadRelays`, not
 * `poolGeneralRelays`, not `accountDataRelays`/`selfStateRelays`, not
 * `effectiveDmRelays`. A broadcast relay is somewhere this client SPEAKS; it is
 * never somewhere this client expects to find anything, so nothing may come to
 * depend on it being reachable, honest, or even still there.
 */
export function broadcastWriteRelays(config: AppConfig): string[] {
  if (!config.useAppRelays) return [];
  const out = new Set<string>();
  for (const url of config.broadcastRelays) {
    const normalized = normalizeRelayUrl(url);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/**
 * The user's own NIP-65 read relays to fold into the general pool's REQ
 * routing, or none when `useUserRelays` is off. Ported from Ditto's
 * `getEffectiveRelays` (the `useUserRelays` half); the app relays are added
 * separately and always, so this returns ONLY the user's personal read relays.
 */
export function userReadRelays(config: AppConfig, pubkey?: string): string[] {
  if (!config.useUserRelays) return [];
  if (pubkey && config.relayMetadata.pubkey && config.relayMetadata.pubkey !== pubkey) return [];
  return config.relayMetadata.relays.filter((r) => r.read).map((r) => r.url);
}

/**
 * The user's own NIP-65 write relays to fold into the general pool's EVENT
 * routing, or none when `useUserRelays` is off. Companion to
 * `userReadRelays` — see there.
 */
export function userWriteRelays(config: AppConfig, pubkey?: string): string[] {
  if (!config.useUserRelays) return [];
  if (pubkey && config.relayMetadata.pubkey && config.relayMetadata.pubkey !== pubkey) return [];
  return config.relayMetadata.relays.filter((r) => r.write).map((r) => r.url);
}

/**
 * The relays a user's ACCOUNT-DATA singletons live on — app relays (unless the
 * user switched them off) and the user's own NIP-65 WRITE relays when
 * `useUserRelays` is on. NIP-65's marker describes the user's behavior: their
 * authored events are downloaded from their write relays; their read relays
 * receive events that mention them. Deliberately EXCLUDES joined NIP-29 group
 * relays: a personal replaceable list (kind 10030 emojis, etc.) is account data
 * this client publishes to the app relays, not group-scoped traffic.
 *
 * Reads that need a reliable `EOSE` must scope to this set rather than the full
 * pool. `NPool.req` only surfaces the merged EOSE once EVERY routed relay has
 * EOSE'd; fanning a personal-list read out to every joined server means one
 * cold/slow/AUTH-gated group relay withholds that EOSE, so "a relay confirmed
 * the list's absence" can never be observed. Scoping to the handful of
 * account-data relays keeps the all-relays EOSE achievable — and is where the
 * list actually is.
 */
export function accountDataRelays(config: AppConfig, pubkey?: string): string[] {
  const urls = new Set<string>();
  if (config.useAppRelays) {
    for (const url of config.appRelays) {
      const normalized = normalizeRelayUrl(url);
      if (normalized) urls.add(normalized);
    }
  }
  for (const url of userWriteRelays(config, pubkey)) {
    const normalized = normalizeRelayUrl(url);
    if (normalized) urls.add(normalized);
  }
  return [...urls];
}

/**
 * Relays that carry the logged-in user's portable self-state.
 *
 * This starts with the ordinary account-data set, then always includes the
 * user's declared NIP-65 write relays even when `useUserRelays` is off. That
 * toggle controls general profile/list routing; it must not sever the private
 * settings replication the user explicitly initialized with "Sync setup".
 * Other clients discover the same write set from kind 10002 before reading the
 * documents, so this is also the live receive set.
 */
export function selfStateRelays(config: AppConfig, pubkey?: string): string[] {
  const urls = new Set(accountDataRelays(config, pubkey));
  // Strict attribution only: a cached list without a `pubkey` stamp could be
  // a previous account's (the field is optional in legacy persisted configs).
  // NostrSync stamps the owner on every kind-10002 hydrate, so an unstamped
  // config regains its write relays on the first boot that reads the list.
  const ownsRelayList = !!pubkey && config.relayMetadata.pubkey === pubkey;
  if (ownsRelayList) {
    for (const relay of config.relayMetadata.relays) {
      if (!relay.write) continue;
      const normalized = normalizeRelayUrl(relay.url);
      if (normalized) urls.add(normalized);
    }
  }
  return [...urls];
}
