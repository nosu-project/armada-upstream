/**
 * Channel ordering — an Armada client convention (see CORD.md). CORD-03 has no
 * ordering field, so a Channel MAY carry `custom["armada.order"] = { position }`
 * (per-entity, like CORD-04 Roles, so concurrent reorders collide per channel).
 * Advisory: unpositioned channels sort after positioned ones by name.
 */

import type { ChannelMetadata } from "@/concord/lib/types";

export const ARMADA_CHANNEL_ORDER_METADATA_KEY = "armada.order";

/** Sorts after every positioned channel, without claiming a real position. */
export const UNPOSITIONED = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The channel's sidebar position, or undefined when it carries none. */
export function channelPosition(metadata: ChannelMetadata): number | undefined {
  const extension = isRecord(metadata.custom) ? metadata.custom[ARMADA_CHANNEL_ORDER_METADATA_KEY] : undefined;
  if (!isRecord(extension)) return undefined;
  const position = extension.position;
  if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) return undefined;
  return position;
}

/** Metadata with the position set (or cleared), other extensions untouched. */
export function withChannelPosition(metadata: ChannelMetadata, position: number | undefined): ChannelMetadata {
  const custom: Record<string, unknown> = isRecord(metadata.custom) ? { ...metadata.custom } : {};
  if (position === undefined) delete custom[ARMADA_CHANNEL_ORDER_METADATA_KEY];
  else custom[ARMADA_CHANNEL_ORDER_METADATA_KEY] = { position };
  const next: ChannelMetadata = { ...metadata };
  if (Object.keys(custom).length > 0) next.custom = custom;
  else delete next.custom;
  return next;
}

/** The display comparator: position first, then name — one order on every client. */
export function compareChannelOrder(
  a: { position?: number; name: string },
  b: { position?: number; name: string },
): number {
  const pa = a.position ?? UNPOSITIONED;
  const pb = b.position ?? UNPOSITIONED;
  return pa - pb || a.name.localeCompare(b.name);
}

/**
 * Positions to publish so `channels` (in display order) reads as `from` moved to
 * `to`: sequential 0..n-1, returning only changed channels. The first reorder in
 * a never-ordered community stamps them all.
 */
export function reorderPositions(
  channels: Array<{ idHex: string; position?: number }>,
  from: number,
  to: number,
): Array<{ idHex: string; position: number }> {
  if (from === to || from < 0 || to < 0 || from >= channels.length || to >= channels.length) return [];
  const next = [...channels];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const out: Array<{ idHex: string; position: number }> = [];
  next.forEach((channel, index) => {
    if (channel.position !== index) out.push({ idHex: channel.idHex, position: index });
  });
  return out;
}
