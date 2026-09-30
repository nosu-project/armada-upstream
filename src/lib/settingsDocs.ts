/**
 * The user's seven encrypted NIP-78 settings documents (kind 30078, NIP-44 to
 * self, `d` = `${APP_ID}/<name>`). Split by write pattern, not topic, because
 * a replaceable event is rewritten whole on every field change. See
 * `docs/settings-documents.md`.
 *
 * @see ../hooks/useSettingsDoc — the read/write hook these describe
 * @see ../contexts/AppContext — METADATA/RAIL/NOTIF/DM_CONFIG_KEYS
 */

import {
  DmsDocSchema,
  MetadataDocSchema,
  NotificationsDocSchema,
  RailDocSchema,
  ReactionsDocSchema,
  ReadStateDocSchema,
  type MetadataDoc,
} from "@/lib/schemas";
import { APP_ID } from "@/lib/platform";

import type { z } from "zod";
import type { RailLayoutNode } from "@/lib/railLayout";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-78 application-specific data. */
export const SETTINGS_KIND = 30078;

/**
 * Adding one needs: a name here, a schema in `schemas.ts`, a key list in
 * `AppContext.ts` if it mirrors AppConfig, and the Android service's default set.
 */
export const SETTINGS_DOC_NAMES = [
  "metadata",
  "rail",
  "read-state",
  "read-state-recent",
  "notifications",
  "dms",
  "reactions",
] as const;

export type SettingsDocName = (typeof SETTINGS_DOC_NAMES)[number];

/** `${APP_ID}/<name>` keeps forks and other NIP-78 clients from colliding. */
export function settingsDTag(name: SettingsDocName): string {
  return `${APP_ID}/${name}`;
}

/** Every settings `d` tag, for the standing REQ's `#d` filter. */
export const SETTINGS_DTAGS: string[] = SETTINGS_DOC_NAMES.map(settingsDTag);

/** The document a `d` tag names, or undefined if it isn't one of ours. */
export function settingsDocForDTag(dTag: string): SettingsDocName | undefined {
  return SETTINGS_DOC_NAMES.find((name) => settingsDTag(name) === dTag);
}

/** The zod schema for each document's plaintext. */
export const SETTINGS_DOC_SCHEMAS = {
  "metadata": MetadataDocSchema,
  "rail": RailDocSchema,
  "read-state": ReadStateDocSchema,
  // Only the entries newer than `read-state`'s; see ReadStateProvider.
  "read-state-recent": ReadStateDocSchema,
  "notifications": NotificationsDocSchema,
  "dms": DmsDocSchema,
  "reactions": ReactionsDocSchema,
} as const;

/** The plaintext type of the document named `N`. */
export type ParsedSettingsDoc<N extends SettingsDocName> = z.infer<(typeof SETTINGS_DOC_SCHEMAS)[N]>;

/**
 * Validate a decrypted settings document, dropping only the top-level fields
 * that fail (e.g. an enum value from a newer build) rather than the whole doc.
 * Null if not an object or still invalid after dropping.
 */
export function parseSettingsDoc<N extends SettingsDocName>(
  name: N,
  value: unknown,
): { doc: ParsedSettingsDoc<N>; dropped: string[] } | null {
  const schema = SETTINGS_DOC_SCHEMAS[name];
  const first = schema.safeParse(value);
  if (first.success) return { doc: first.data as ParsedSettingsDoc<N>, dropped: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const dropped = new Set<string>();
  for (const issue of first.error.issues) {
    const key = issue.path[0];
    // An issue with no field to blame is about the document itself.
    if (typeof key !== "string") return null;
    dropped.add(key);
  }
  const rest = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !dropped.has(key)),
  );
  const second = schema.safeParse(rest);
  return second.success
    ? { doc: second.data as ParsedSettingsDoc<N>, dropped: [...dropped] }
    : null;
}

/**
 * Fields each split document took out of `armada/metadata`; doubles as the
 * metadata writer's strip list ({@link stripMigratedKeys}).
 */
export const MIGRATED_KEYS = {
  "rail": ["railLayout", "railOrder"],
  "read-state": ["readState"],
  "read-state-recent": [],
  "notifications": ["notifLevels", "mutedCommunities", "mutedChannels"],
  "dms": ["dmProtocol", "pinnedDms", "closedDms", "acceptedDms", "startedDms"],
  "reactions": ["frequentReactions"],
} as const satisfies Record<Exclude<SettingsDocName, "metadata">, readonly (keyof MetadataDoc)[]>;

/** Every key any split document claims from the legacy metadata document. */
const ALL_MIGRATED_KEYS: readonly string[] = Object.values(MIGRATED_KEYS).flat();

/**
 * Drop the split fields from a metadata document about to be written. Legacy
 * fields must only appear when an OLD build wrote them, otherwise
 * {@link resolveLegacy} could restore a stale rail after a theme change.
 */
export function stripMigratedKeys(doc: MetadataDoc): MetadataDoc {
  const out: Record<string, unknown> = { ...doc };
  for (const key of ALL_MIGRATED_KEYS) delete out[key];
  return out as MetadataDoc;
}

/** Whether a metadata document still carries any of a split document's fields. */
export function hasMigratedKeys(
  doc: MetadataDoc | null | undefined,
  name: Exclude<SettingsDocName, "metadata">,
): boolean {
  if (!doc) return false;
  return MIGRATED_KEYS[name].some((key) => doc[key] !== undefined);
}

/**
 * During migration, pick between a split document and legacy fields in
 * `armada/metadata` (written by older builds): newer `created_at` wins. Not
 * used for `read-state`/`reactions`, whose merges are commutative.
 */
export function resolveLegacy<T>(
  name: Exclude<SettingsDocName, "metadata">,
  split: { doc: T; event: NostrRumor } | null,
  metadata: { doc: MetadataDoc; event: NostrRumor } | null,
): { doc: T; event: NostrRumor } | null {
  if (!metadata || !hasMigratedKeys(metadata.doc, name)) return split;
  if (split && split.event.created_at >= metadata.event.created_at) return split;

  const legacy: Record<string, unknown> = {};
  for (const key of MIGRATED_KEYS[name]) {
    if (metadata.doc[key] !== undefined) legacy[key] = metadata.doc[key];
  }
  // Uses the METADATA event as identity so "already applied?" guards re-fire
  // when the legacy source is superseded.
  return { doc: legacy as T, event: metadata.event };
}

/** The rail layout a document holds, seeding from the legacy flat `railOrder` (read-only). */
export function railLayoutOf(
  doc: { railLayout?: RailLayoutNode[]; railOrder?: string[] } | null | undefined,
): RailLayoutNode[] | undefined {
  if (!doc) return undefined;
  if (doc.railLayout && doc.railLayout.length > 0) return doc.railLayout;
  if (doc.railOrder && doc.railOrder.length > 0) {
    return doc.railOrder.map((key): RailLayoutNode => ({ type: "item", key }));
  }
  return doc.railLayout;
}
