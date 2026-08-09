import {
  DM_CONFIG_KEYS,
  METADATA_CONFIG_KEYS,
  NOTIF_CONFIG_KEYS,
  RAIL_CONFIG_KEYS,
  type AppConfig,
} from "@/contexts/AppContext";

import { railLayoutOf, type SettingsDocName } from "@/lib/settingsDocs";

import type { RailLayoutNode } from "@/lib/railLayout";

/**
 * The AppConfig keys each settings document carries. Documents whose contents
 * aren't AppConfig fields (`read-state`, `reactions`) have none — they are
 * synced by their owning module rather than through the config.
 */
export const CONFIG_KEYS_BY_DOC = {
  "metadata": METADATA_CONFIG_KEYS,
  "rail": RAIL_CONFIG_KEYS,
  "notifications": NOTIF_CONFIG_KEYS,
  "dms": DM_CONFIG_KEYS,
} as const satisfies Partial<Record<SettingsDocName, readonly (keyof AppConfig)[]>>;

/** A settings document that mirrors a slice of AppConfig. */
export type ConfigDocName = keyof typeof CONFIG_KEYS_BY_DOC;

export const CONFIG_DOC_NAMES = Object.keys(CONFIG_KEYS_BY_DOC) as ConfigDocName[];

/**
 * Pick the fields one settings document carries out of AppConfig — the value
 * to publish, and the snapshot the publish watcher diffs against.
 *
 * Undefined values are omitted rather than written as `undefined`: they'd
 * serialize to nothing through `JSON.stringify` anyway, and omitting them
 * keeps the change-detection snapshot stable for optional keys like
 * `customTheme`.
 */
export function configSnapshot(config: AppConfig, name: ConfigDocName): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS_BY_DOC[name]) {
    const value = config[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The AppConfig fields to apply from an incoming settings document. */
export function docToConfigPatch(
  name: ConfigDocName,
  doc: Record<string, unknown>,
): Partial<AppConfig> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS_BY_DOC[name]) {
    const value = doc[key];
    if (value !== undefined) out[key] = value;
  }
  // The rail is the one document with a legacy spelling to understand: a
  // pre-folder client stored a flat `railOrder` and no layout.
  if (name === "rail") {
    const layout = railLayoutOf(doc as { railLayout?: RailLayoutNode[]; railOrder?: string[] });
    if (layout !== undefined) out.railLayout = layout;
  }
  return out as Partial<AppConfig>;
}
