import {
  DM_CONFIG_KEYS,
  METADATA_CONFIG_KEYS,
  NOTIF_CONFIG_KEYS,
  RAIL_CONFIG_KEYS,
  type AppConfig,
  type ClosedDmMarker,
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

/**
 * The AppConfig fields to apply from an incoming settings document, merged
 * against the config we already hold.
 *
 * `current` matters only for the `dms` document (see {@link mergeDmMaps}):
 * every other field is applied wholesale, so the current value is ignored.
 */
export function docToConfigPatch(
  name: ConfigDocName,
  doc: Record<string, unknown>,
  current: AppConfig,
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
  if (name === "dms") mergeDmMaps(out, current);
  return out as Partial<AppConfig>;
}

/**
 * Union the additive per-peer DM maps of an incoming `dms` patch into the ones
 * we already hold, in place.
 *
 * The `dms` document is a single last-writer-wins blob, so a device that edits
 * ANY field in it republishes its whole `closedDms`/`pinnedDms`/… — including a
 * stale copy that predates a hide another device (e.g. Android vs. web) just
 * made. Applying that wholesale would DROP the hide. Unioning instead means a
 * hide (or an accept, a started thread, a pin) present on either side survives,
 * so the wipe cannot happen; the two devices converge to the union over their
 * next edits.
 *
 * The cost is that a REMOVAL (reopen, unpin) becomes best-effort across devices
 * rather than authoritative — acceptable because it is far milder than losing a
 * hide, and for a reopened hide it self-heals: the next message reopens it
 * locally on every device via `reopenForNewMessages`. On a `closedDms` conflict
 * the marker closed against the NEWER message (higher `createdAt`) wins.
 *
 * `dmProtocol` is deliberately left wholesale: it is a mutable per-peer setting,
 * not an additive set, so it has no accumulated state a stale republish can
 * lose.
 */
function mergeDmMaps(patch: Record<string, unknown>, current: AppConfig): void {
  if (patch.closedDms) {
    const merged: Record<string, ClosedDmMarker> = { ...current.closedDms };
    for (const [peer, marker] of Object.entries(patch.closedDms as Record<string, ClosedDmMarker>)) {
      const existing = merged[peer];
      if (!existing || marker.createdAt > existing.createdAt) merged[peer] = marker;
    }
    patch.closedDms = merged;
  }
  for (const key of ["pinnedDms", "acceptedDms", "startedDms"] as const) {
    if (patch[key]) {
      patch[key] = [...new Set([...current[key], ...(patch[key] as string[])])];
    }
  }
}
