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
 * Validates the persisted AppConfig. Used field-by-field in AppProvider so a
 * single corrupt key never wipes the entire config.
 */
export const AppConfigSchema = z.object({
  theme: z.enum(["light", "dark", "system", "custom"]).catch("dark"),
  customTheme: ThemeConfigSchema.optional().catch(undefined),
  themes: ThemesConfigSchema.optional().catch(undefined),
  addedRelays: z.array(z.string()).catch([]),
  serverOrder: z.array(z.string()).catch([]),
  railOrder: z.array(z.string()).catch([]),
  railLayout: z.array(RailLayoutNodeSchema).catch([]),
  railOpenFolders: z.array(z.string()).catch([]),
  appRelays: z.array(z.string()).catch(defaultConfig.appRelays),
  searchRelays: z.array(z.string()).catch(defaultConfig.searchRelays),
  useOwnDmRelays: z.boolean().catch(defaultConfig.useOwnDmRelays),
  dmRelays: z.array(z.string()).catch(defaultConfig.dmRelays),
  blossomServerMetadata: BlossomServerMetadataSchema.catch(defaultConfig.blossomServerMetadata),
  useAppBlossomServers: z.boolean().catch(defaultConfig.useAppBlossomServers),
  lastChannelByServer: z.record(z.string(), z.string()).catch({}),
  mutedCommunities: z.array(z.string()).catch([]),
  mutedChannels: z.array(z.string()).catch([]),
  notifLevels: z.record(z.string(), z.enum(["all", "mentions", "nothing"])).catch({}),
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
  /**
   * Cache of the user's NIP-29 server list. Canonically lives in the kind
   * 10009 list; synced here too so a fresh device paints the rail before the
   * 10009 read resolves. Merged (union) on the way in, never used to remove.
   */
  addedRelays: z.array(z.string()).optional(),
  /** Legacy per-server rail order (relay URLs). */
  serverOrder: z.array(z.string()).optional(),
  /** Unified community-rail order (relay URLs + `c1:`/`c2:` community keys). */
  railOrder: z.array(z.string()).optional(),
  /** Structured rail layout: ordered items + folders (supersedes railOrder). */
  railLayout: z.array(RailLayoutNodeSchema).optional(),
  /** General-purpose app relays. */
  appRelays: z.array(z.string()).optional(),
  /** NIP-50 search relays. */
  searchRelays: z.array(z.string()).optional(),
  /** Whether DMs use the user's own relays instead of the app relays. */
  useOwnDmRelays: z.boolean().optional(),
  /** The user's custom DM relays. */
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
