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

export const ThemesConfigSchema = z.object({
  light: ThemeConfigSchema,
  dark: ThemeConfigSchema,
});

/** The user's Blossom server list + kind 10063 sync timestamp (BUD-03). */
export const BlossomServerMetadataSchema = z.object({
  servers: z.array(z.string()),
  updatedAt: z.number(),
});

/** The user's NIP-65 relay list + kind 10002 sync timestamp. */
export const RelayMetadataSchema = z.object({
  relays: z.array(
    z.object({ url: z.string(), read: z.boolean(), write: z.boolean() }),
  ),
  updatedAt: z.number(),
  pubkey: z.string().optional(),
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
  themes: ThemesConfigSchema.optional().catch(undefined),
  railOrder: z.array(z.string()).catch([]),
  railLayout: z.array(RailLayoutNodeSchema).catch([]),
  railOpenFolders: z.array(z.string()).catch([]),
  collapsedChannelCategories: z.record(z.string(), z.array(z.string())).catch({}),
  memberListVisible: z.boolean().optional().catch(undefined),
  appRelays: z.array(z.string()).catch(defaultConfig.appRelays),
  searchRelays: z.array(z.string()).catch(defaultConfig.searchRelays),
  preferredVoiceServer: z.string().catch(defaultConfig.preferredVoiceServer),
  useAppRelays: z.boolean().catch(defaultConfig.useAppRelays),
  useUserRelays: z.boolean().catch(defaultConfig.useUserRelays),
  relayMetadata: RelayMetadataSchema.catch(defaultConfig.relayMetadata),
  useAppDmRelays: z.boolean().catch(defaultConfig.useAppDmRelays),
  useOwnDmRelays: z.boolean().catch(defaultConfig.useOwnDmRelays),
  dmRelays: z.array(z.string()).catch(defaultConfig.dmRelays),
  blossomServerMetadata: BlossomServerMetadataSchema.catch(defaultConfig.blossomServerMetadata),
  useAppBlossomServers: z.boolean().catch(defaultConfig.useAppBlossomServers),
  lastChannelByServer: z.record(z.string(), z.string()).catch({}),
  mutedCommunities: z.array(z.string()).catch([]),
  mutedChannels: z.array(z.string()).catch([]),
  notifLevels: z.record(z.string(), z.enum(["all", "mentions", "nothing"])).catch({}),
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).catch({}),
  pinnedDms: z.array(z.string()).catch([]),
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).catch({}),
  acceptedDms: z.array(z.string()).catch([]),
  startedDms: z.array(z.string()).catch([]),
  discoverAllContent: z.boolean().catch(defaultConfig.discoverAllContent),
  meshIncognito: z.boolean().catch(defaultConfig.meshIncognito),
  meshEnabled: z.boolean().catch(defaultConfig.meshEnabled),
});

/**
 * Encrypted app settings synced across devices via a NIP-78 (kind 30078)
 * event, NIP-44-encrypted to self. A loose object so unknown future keys are
 * preserved rather than rejected.
 */
export const EncryptedSettingsSchema = z.looseObject({
  theme: z.enum(["light", "dark", "system", "custom"]).optional(),
  customTheme: ThemeConfigSchema.optional(),
  themes: ThemesConfigSchema.optional(),
  // NOTE: `addedRelays` is gone. The NIP-29 server set is read from the kind
  // 10009 list only. The schema is loose, so an `addedRelays` key left in an
  // older device's blob passes through untouched and is simply ignored.
  /** Unified community-rail order (relay URLs + `c1:`/`c2:` community keys). */
  railOrder: z.array(z.string()).optional(),
  /** Structured rail layout: ordered items + folders (supersedes railOrder). */
  railLayout: z.array(RailLayoutNodeSchema).optional(),
  /** General-purpose app relays. */
  appRelays: z.array(z.string()).optional(),
  /** NIP-50 search relays. */
  searchRelays: z.array(z.string()).optional(),
  /** Portable Concord/DM voice host preference. */
  preferredVoiceServer: z.string().optional(),
  /** Whether the app relays are used in the general pool (foot-gun when off). */
  useAppRelays: z.boolean().optional(),
  /** Whether the user's own NIP-65 relays are folded into the general pool. */
  useUserRelays: z.boolean().optional(),
  /** The user's NIP-65 relay list (canonical source: kind 10002). */
  relayMetadata: RelayMetadataSchema.optional(),
  /** Whether DMs use the app's default DM relays. */
  useAppDmRelays: z.boolean().optional(),
  /** Whether DMs also use the user's own relays. */
  useOwnDmRelays: z.boolean().optional(),
  /** The user's own DM relays (personal only, never the app defaults). */
  dmRelays: z.array(z.string()).optional(),
  /** The user's Blossom server list (canonical source: kind 10063). */
  blossomServerMetadata: BlossomServerMetadataSchema.optional(),
  /** Whether app default Blossom servers are used alongside the user's. */
  useAppBlossomServers: z.boolean().optional(),
  /** Last channel/room opened per server/community (see AppConfig). */
  lastChannelByServer: z.record(z.string(), z.string()).optional(),
  /** Muted communities, by stable rail key (see AppConfig). */
  mutedCommunities: z.array(z.string()).optional(),
  /** Muted channels/rooms, by stable conversation key (see AppConfig). */
  mutedChannels: z.array(z.string()).optional(),
  /** Per-conversation notification level (all/mentions/nothing) — see AppConfig. */
  notifLevels: z.record(z.string(), z.enum(["all", "mentions", "nothing"])).optional(),
  /** Per-conversation DM encryption preference (auto/nip17/nip04) — see AppConfig. */
  dmProtocol: z.record(z.string(), z.enum(["auto", "nip17", "nip04"])).optional(),
  /** Pinned DM peers (hex pubkeys) in pin order — see AppConfig. */
  pinnedDms: z.array(z.string()).optional(),
  /** DMs dismissed from the sidebar until a newer message arrives. */
  closedDms: z.record(z.string(), ClosedDmMarkerSchema).optional(),
  /** DM peers accepted out of the request tier (hex pubkeys) — see AppConfig. */
  acceptedDms: z.array(z.string()).optional(),
  /** DM peers with a kept row but no messages yet (hex pubkeys) — see AppConfig. */
  startedDms: z.array(z.string()).optional(),
  /** Whether unknown-sender DMs are surfaced in the request tier — see AppConfig. */
  showDmRequests: z.boolean().optional(),
  /** Whether Discover shows the unfiltered firehose vs the allow-list (see AppConfig). */
  discoverAllContent: z.boolean().optional(),
  /**
   * The user's quick-reaction frequency table. Merged per key on the way in
   * (highest count / most recent use wins) rather than replaced, so two
   * devices reacting independently don't reset each other's counts.
   */
  frequentReactions: z.array(FrequentReactionSchema).optional(),
  /**
   * Per-conversation last-read timestamps (unix seconds), keyed by a stable
   * conversation id (e.g. `${relayUrl}::${groupId}` for channels, `dm:${pubkey}`
   * for direct messages). Drives unread/mention badges across devices.
   */
  readState: z.record(z.string(), z.number()).optional(),
  /** ms timestamp of the last write, used to resolve sync conflicts. */
  lastSync: z.number().optional(),
});

export type EncryptedSettings = z.infer<typeof EncryptedSettingsSchema>;
