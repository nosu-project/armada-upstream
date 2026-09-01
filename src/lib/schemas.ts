import { z } from "zod";

import { defaultConfig } from "@/contexts/AppContext";

import type { RailLayoutNode } from "@/lib/railLayout";

/** An HSL string like "228 20% 10%". */
const HslStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/, "Expected an HSL string like '228 20% 10%'");

export const CoreThemeColorsSchema = z.object({
  background: HslStringSchema,
  text: HslStringSchema,
  primary: HslStringSchema,
});

export const ThemeConfigSchema = z.object({
  title: z.string().optional(),
  colors: CoreThemeColorsSchema,
});

/** The user's Blossom server list + kind 10063 sync timestamp (BUD-03). */
export const BlossomServerMetadataSchema = z.object({
  servers: z.array(z.string()),
  updatedAt: z.number(),
  eventId: z.string().optional(),
});

/** The user's NIP-65 relay list + kind 10002 sync timestamp. */
export const RelayMetadataSchema = z.object({
  relays: z.array(
    z.object({ url: z.string(), read: z.boolean(), write: z.boolean() }),
  ),
  updatedAt: z.number(),
  eventId: z.string().optional(),
  pubkey: z.string().optional(),
});

/** Account-global notification categories shared by every delivery path. */
export const PushPrefsSchema = z.object({
  mentions: z.boolean(),
  reactions: z.boolean(),
  replies: z.boolean(),
  directMessages: z.boolean(),
  allGroupMessages: z.boolean(),
  dmRequests: z.enum(["off", "generic", "full"]),
});

/**
 * A node in the community rail's structured layout: a bare item (by stable
 * rail key) or a Discord-style folder of items. See lib/railLayout.ts.
 */
export const RailLayoutNodeSchema: z.ZodType<RailLayoutNode> = z.union([
  z.object({ type: z.literal("item"), key: z.string() }),
  z.object({
    type: z.literal("folder"),
    id: z.string(),
    name: z.string(),
    keys: z.array(z.string()),
  }),
]);

/**
 * One entry in the user's quick-reaction frequency table (see
 * hooks/useFrequentReactions). `url` is set only for custom `:shortcode:`
 * emoji.
 */
export const FrequentReactionSchema = z.object({
  key: z.string(),
  url: z.string().optional(),
  pickerId: z.string().optional(),
  count: z.number(),
  usedAt: z.number(),
});

const ClosedDmMarkerSchema = z.object({
  eventId: z.string().optional(),
  createdAt: z.number(),
});

/**
 * Validates the persisted AppConfig. Used field-by-field in AppProvider so a
 * single corrupt key never wipes the entire config.
 */
export const AppConfigSchema = z.object({
  theme: z.enum(["light", "dark", "system", "custom"]).catch("dark"),
  customTheme: ThemeConfigSchema.optional().catch(undefined),
  railLayout: z.array(RailLayoutNodeSchema).catch([]),
  railOpenFolders: z.array(z.string()).catch([]),
  collapsedChannelCategories: z.record(z.string(), z.array(z.string())).catch({}),
  memberListVisible: z.boolean().optional().catch(undefined),
  appRelays: z.array(z.string()).catch(defaultConfig.appRelays),
  broadcastRelays: z.array(z.string()).catch(defaultConfig.broadcastRelays),
  communityRelays: z.array(z.string()).catch(defaultConfig.communityRelays),
  searchRelays: z.array(z.string()).catch(defaultConfig.searchRelays),
  preferredVoiceServer: z.string().catch(defaultConfig.preferredVoiceServer),
  automaticSettingsSync: z.boolean().catch(defaultConfig.automaticSettingsSync),
  useAppRelays: z.boolean().catch(defaultConfig.useAppRelays),
  useUserRelays: z.boolean().catch(defaultConfig.useUserRelays),
  relayMetadata: RelayMetadataSchema.catch(defaultConfig.relayMetadata),
  useAppDmRelays: z.boolean().catch(defaultConfig.useAppDmRelays),
  appDmRelays: z.array(z.string()).catch(defaultConfig.appDmRelays),
  useOwnDmRelays: z.boolean().catch(defaultConfig.useOwnDmRelays),
  dmRelays: z.array(z.string()).catch(defaultConfig.dmRelays),
  blossomServerMetadata: BlossomServerMetadataSchema.catch(defaultConfig.blossomServerMetadata),
  useAppBlossomServers: z.boolean().catch(defaultConfig.useAppBlossomServers),
  appBlossomServers: z.array(z.string()).catch(defaultConfig.appBlossomServers),
  lastChannelByServer: z.record(z.string(), z.string()).catch({}),
  mutedCommunities: z.array(z.string()).catch([]),
  mutedChannels: z.array(z.string()).catch([]),
  notifLevels: z.record(z.string(), z.enum(["all", "mentions", "nothing"])).catch({}),
  pushPrefs: PushPrefsSchema.catch(defaultConfig.pushPrefs),
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).catch({}),
  dmTypingIndicators: z.boolean().catch(defaultConfig.dmTypingIndicators),
  dmsDisabled: z.boolean().catch(defaultConfig.dmsDisabled),
  pinnedDms: z.array(z.string()).catch([]),
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).catch({}),
  acceptedDms: z.array(z.string()).catch([]),
  startedDms: z.array(z.string()).catch([]),
  showDmRequests: z.boolean().catch(defaultConfig.showDmRequests),
  showRecentRailDms: z.boolean().catch(defaultConfig.showRecentRailDms),
  discoverAllContent: z.boolean().catch(defaultConfig.discoverAllContent),
  stripTrackingParams: z.boolean().catch(defaultConfig.stripTrackingParams),
  defaultZapAmount: z.number().catch(defaultConfig.defaultZapAmount),
  defaultZapMethod: z.enum(["lightning", "bitcoin"]).catch(defaultConfig.defaultZapMethod),
  zapsEnabled: z.boolean().catch(defaultConfig.zapsEnabled),
  accountStandingSeen: z.boolean().catch(defaultConfig.accountStandingSeen),
  meshIncognito: z.boolean().catch(defaultConfig.meshIncognito),
  meshEnabled: z.boolean().catch(defaultConfig.meshEnabled),
});

// ─── Encrypted NIP-78 settings documents ─────────────────────────────────
//
// One kind-30078 document per domain, NIP-44-encrypted to self. See
// `lib/settingsDocs.ts` for the catalogue that binds these to their `d` tags,
// and `docs/settings-documents.md` for the whole design.
//
// Every document schema is LOOSE, for two reasons: a key this build doesn't
// know is preserved on read-modify-write rather than dropped (so a newer
// Armada on another device doesn't lose its settings every time this one
// writes), and the split fields left behind in `armada/metadata` by older
// builds stay readable during the migration window.

/** Per-conversation notification level (all/mentions/nothing) — see AppConfig. */
const NotifLevelsSchema = z.record(z.string(), z.enum(["all", "mentions", "nothing"]));
/** Per-conversation last-read timestamps (unix seconds), keyed by conversation id. */
const ReadStateMapSchema = z.record(z.string(), z.number());

/**
 * `${APP_ID}/metadata` — the user's bounded preferences. Everything here is a
 * scalar or a short, human-sized list, written when the user changes a
 * setting. Anything that grows with use lives in its own document below.
 */
export const MetadataDocSchema = z.looseObject({
  theme: z.enum(["light", "dark", "system", "custom"]).optional(),
  customTheme: ThemeConfigSchema.optional(),
  /** General-purpose app relays. */
  appRelays: z.array(z.string()).optional(),
  /** Write-only relays: general pool publishes go here too, reads never do. */
  broadcastRelays: z.array(z.string()).optional(),
  /** Default home relays for newly created Concord communities. */
  communityRelays: z.array(z.string()).optional(),
  /** Portable Concord/DM voice host preference. */
  preferredVoiceServer: z.string().optional(),
  /** Whether the app relays are used in the general pool (foot-gun when off). */
  useAppRelays: z.boolean().optional(),
  /** Whether the user's own NIP-65 relays are folded into the general pool. */
  useUserRelays: z.boolean().optional(),
  /** Whether DMs use the app's default DM relays. */
  useAppDmRelays: z.boolean().optional(),
  /** Complete app-provided DM relay set; replaces the build defaults. */
  appDmRelays: z.array(z.string()).optional(),
  /** Whether DMs also use the user's own relays. */
  useOwnDmRelays: z.boolean().optional(),
  /** Whether app default Blossom servers are used alongside the user's. */
  useAppBlossomServers: z.boolean().optional(),
  /** Complete app-provided Blossom server set; replaces the build defaults. */
  appBlossomServers: z.array(z.string()).optional(),
  /** Whether typing indicators are sent and shown in DMs (see AppConfig). */
  dmTypingIndicators: z.boolean().optional(),
  /** Whether direct messages are turned off entirely (see AppConfig). */
  dmsDisabled: z.boolean().optional(),
  /** Whether unknown-sender DMs are surfaced in the request tier — see AppConfig. */
  showDmRequests: z.boolean().optional(),
  /** Whether the rail shows the automatic recent-unread DM strip (see AppConfig). */
  showRecentRailDms: z.boolean().optional(),
  /** Whether Discover shows the unfiltered firehose vs the allow-list (see AppConfig). */
  discoverAllContent: z.boolean().optional(),
  /** Whether tracking parameters are stripped from links, sent and shown (see AppConfig). */
  stripTrackingParams: z.boolean().optional(),
  /** Preselected zap amount, in sats. */
  defaultZapAmount: z.number().optional(),
  /** Default zap payment method. */
  defaultZapMethod: z.enum(["lightning", "bitcoin"]).optional(),
  /** Whether zap/wallet UI is shown at all. */
  zapsEnabled: z.boolean().optional(),
  /** Whether Account Standing has been opened, retiring its nag (see AppConfig). */
  accountStandingSeen: z.boolean().optional(),

  // ── Read-only legacy ──────────────────────────────────────────────────
  //
  // NOTE: `addedRelays` is gone. The NIP-29 server set is read from the kind
  // 10009 list only. The schema is loose, so an `addedRelays` key left in an
  // older device's blob passes through untouched and is simply ignored. Same
  // for `themes` (a per-mode override of the builtin light/dark palettes that
  // this client only ever read, never wrote) and `lastChannelByServer` (which
  // stopped syncing when it turned out two open clients yank each other's
  // channel selection around).

  /**
   * Local mirrors of lists whose canonical home is a standard event — kinds
   * 10007, 10050, 10002 and 10063 respectively. Pre-migration clients stored
   * them ONLY here, so they are read exactly once, by `useInitialSync`, to
   * rescue a user whose canonical event doesn't exist yet. Never written.
   */
  searchRelays: z.array(z.string()).optional(),
  dmRelays: z.array(z.string()).optional(),
  relayMetadata: RelayMetadataSchema.optional(),
  blossomServerMetadata: BlossomServerMetadataSchema.optional(),

  /**
   * The fields that moved out into their own documents. A build predating the
   * split wrote them here, so they are still READ — see `resolveLegacy` in
   * `lib/settingsDocs.ts`, which prefers whichever of the two documents is
   * newer. This build strips them on every metadata write, which is what makes
   * that timestamp comparison mean anything: their presence proves an older
   * build wrote this document.
   */
  railOrder: z.array(z.string()).optional(),
  railLayout: z.array(RailLayoutNodeSchema).optional(),
  notifLevels: NotifLevelsSchema.optional(),
  mutedCommunities: z.array(z.string()).optional(),
  mutedChannels: z.array(z.string()).optional(),
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).optional(),
  pinnedDms: z.array(z.string()).optional(),
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).optional(),
  acceptedDms: z.array(z.string()).optional(),
  startedDms: z.array(z.string()).optional(),
  frequentReactions: z.array(FrequentReactionSchema).optional(),
  readState: ReadStateMapSchema.optional(),

  /**
   * ms timestamp of the last write. Nothing here reads it; it is emitted on
   * THIS document only, because older Armada builds on the user's other
   * devices order versions by it rather than by `created_at`. The split
   * documents postdate those builds and carry no such field.
   */
  lastSync: z.number().optional(),
});

/**
 * `${APP_ID}/rail` — the community rail's arrangement. Grows with every
 * community joined and is rewritten by every drag, which is most of why the
 * split exists.
 *
 * `railLayout` is the whole document: the flat `railOrder` it superseded is
 * `flattenLayout(railLayout)` and nothing more, so it is read (from the legacy
 * metadata document) only to seed a layout that doesn't exist yet.
 */
export const RailDocSchema = z.looseObject({
  railLayout: z.array(RailLayoutNodeSchema).optional(),
});

/**
 * `${APP_ID}/read-state` — per-conversation last-read timestamps, keyed by a
 * stable conversation id (e.g. `${relayUrl}::${groupId}` for channels,
 * `dm:${pubkey}` for direct messages). Drives unread/mention badges across
 * devices.
 *
 * The largest document by far and the only genuinely unbounded one: an entry
 * per channel, DM, thread and mention scope the user has ever opened, with no
 * pruning (dropping an entry reads back as `0`, i.e. the conversation returns
 * as entirely unread — worse than the growth). Merged per key, max wins.
 */
export const ReadStateDocSchema = z.looseObject({
  readState: ReadStateMapSchema.optional(),
});

/**
 * `${APP_ID}/notifications` — per-conversation notification levels, one entry
 * per conversation the user has tuned.
 *
 * `mutedCommunities`/`mutedChannels` are the legacy boolean mutes, still
 * written in lockstep with `notifLevels` for older clients and for the relay
 * push gateway's `muted_groups` (see `useNotifLevels`). Replaced wholesale,
 * not merged: clearing a level has to propagate.
 */
export const NotificationsDocSchema = z.looseObject({
  notifLevels: NotifLevelsSchema.optional(),
  mutedCommunities: z.array(z.string()).optional(),
  mutedChannels: z.array(z.string()).optional(),
  pushPrefs: PushPrefsSchema.optional(),
});

/**
 * `${APP_ID}/dms` — per-peer direct-message state, keyed by peer pubkey.
 *
 * The document is one last-writer-wins blob, but its additive maps
 * (`closedDms`, `pinnedDms`, `acceptedDms`, `startedDms`) are UNIONED into
 * local state on apply rather than replaced — see `mergeDmMaps` in
 * `syncedConfig.ts`. Without that, a device editing any field here republishes
 * a stale whole map and wipes a hide/pin another device just made. The
 * trade-off is that a removal (reopen, unpin) is best-effort across devices;
 * `dmProtocol` alone is a mutable setting with no additive state and stays
 * wholesale.
 */
export const DmsDocSchema = z.looseObject({
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).optional(),
  pinnedDms: z.array(z.string()).optional(),
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).optional(),
  acceptedDms: z.array(z.string()).optional(),
  startedDms: z.array(z.string()).optional(),
});

/**
 * `${APP_ID}/reactions` — the quick-reaction frequency table. Capped at 32
 * entries, so bounded, but rewritten on every reaction the user taps; merged
 * per key on the way in (highest count / most recent use wins) rather than
 * replaced, so two devices reacting independently don't reset each other's
 * counts.
 */
export const ReactionsDocSchema = z.looseObject({
  frequentReactions: z.array(FrequentReactionSchema).optional(),
});

export type MetadataDoc = z.infer<typeof MetadataDocSchema>;
export type RailDoc = z.infer<typeof RailDocSchema>;
export type ReadStateDoc = z.infer<typeof ReadStateDocSchema>;
export type NotificationsDoc = z.infer<typeof NotificationsDocSchema>;
export type DmsDoc = z.infer<typeof DmsDocSchema>;
export type ReactionsDoc = z.infer<typeof ReactionsDocSchema>;
