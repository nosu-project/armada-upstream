/**
 * The catalogue of the user's encrypted NIP-78 settings documents.
 *
 * Armada's private, cross-device settings are not one blob but SIX kind-30078
 * documents, each NIP-44-encrypted to self and named `${APP_ID}/<name>`. The
 * long-form rationale, the migration story and the rules a writer has to keep
 * are in `docs/settings-documents.md`; the short version is that a kind-30078
 * event is REPLACEABLE, so everything sharing one `d` tag is rewritten,
 * re-encrypted and re-published every time any single field changes — and
 * three subsystems on three different debounces were doing exactly that to one
 * document, racing each other's read-modify-write and dragging an unbounded
 * read-state map along with every theme change.
 *
 * Splitting by write pattern rather than by topic is the point: the rail is
 * its own document because a drag rewrites it, not because it is conceptually
 * separate.
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

import type { RailLayoutNode } from "@/lib/railLayout";
import type { NostrRumor } from "@/lib/nostrRumor";

/** NIP-78 application-specific data. */
export const SETTINGS_KIND = 30078;

/**
 * The documents, in no significant order. Adding one means: a name here, a
 * schema in `schemas.ts`, a key list in `AppContext.ts` if it mirrors
 * AppConfig, and the Android service's default set (see
 * {@link SETTINGS_DTAGS}).
 */
export const SETTINGS_DOC_NAMES = [
  "metadata",
  "rail",
  "read-state",
  "notifications",
  "dms",
  "reactions",
] as const;

export type SettingsDocName = (typeof SETTINGS_DOC_NAMES)[number];

/**
 * The `d` tag of a settings document.
 *
 * The `${APP_ID}/<name>` shape is what lets a fork or a custom build own its
 * own documents on the same identity without colliding — and, read the other
 * way, is what keeps Armada's documents out of every other NIP-78 client's
 * way on a kind the whole ecosystem shares.
 */
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
  "notifications": NotificationsDocSchema,
  "dms": DmsDocSchema,
  "reactions": ReactionsDocSchema,
} as const;

/**
 * The fields each split document took out of `armada/metadata`.
 *
 * `metadata` is absent on purpose — it took nothing from itself, and this map
 * doubles as the strip list the metadata writer applies (see
 * {@link stripMigratedKeys}).
 */
export const MIGRATED_KEYS = {
  "rail": ["railLayout", "railOrder"],
  "read-state": ["readState"],
  "notifications": ["notifLevels", "mutedCommunities", "mutedChannels"],
  "dms": ["dmProtocol", "pinnedDms", "closedDms", "acceptedDms", "startedDms"],
  "reactions": ["frequentReactions"],
} as const satisfies Record<Exclude<SettingsDocName, "metadata">, readonly (keyof MetadataDoc)[]>;

/** Every key any split document claims from the legacy metadata document. */
const ALL_MIGRATED_KEYS: readonly string[] = Object.values(MIGRATED_KEYS).flat();

/**
 * Drop the split fields from a metadata document about to be written.
 *
 * This is the half of the migration that makes the other half sound. A legacy
 * field is only meaningful evidence if its presence proves an OLD build wrote
 * the document; if this build carried them forward, an unrelated theme change
 * would bump metadata's `created_at` past the rail document's and
 * {@link resolveLegacy} would happily restore a stale rail.
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
 * Choose between a split document and the legacy fields still sitting in
 * `armada/metadata`, for the migration window.
 *
 * A device running an older build writes the rail (or the mutes, or the read
 * state) into metadata, because that is the only document it knows. A device
 * running this one writes the split document. Both are legitimate, so the
 * newer `created_at` wins — which self-heals in both directions rather than
 * letting either build permanently shadow the other.
 *
 * Convergence: this build strips the legacy fields from every metadata write,
 * so once the user's last old install is upgraded `hasMigratedKeys` goes false
 * forever and this function becomes an identity on the split document.
 *
 * NOT used for `read-state` or `reactions`: their merges are commutative
 * (max timestamp / max count), so those two simply hydrate from both sources
 * and let the merge sort it out.
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
  // Carries the METADATA event as its identity on purpose: an "have I applied
  // this?" guard has to re-fire when the legacy source is superseded, and the
  // split document's id (or its absence) says nothing about that.
  return { doc: legacy as T, event: metadata.event };
}

/**
 * The rail layout a document holds, seeding from the flat `railOrder` when
 * only that is present.
 *
 * `railOrder` predates folders and was written alongside `railLayout` for a
 * while; it is a plain list of rail keys, i.e. exactly what a layout of
 * top-level items with no folders flattens to. This is the only place it is
 * still understood, and nothing writes it.
 */
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
