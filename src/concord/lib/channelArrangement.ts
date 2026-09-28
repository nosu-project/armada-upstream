/**
 * What a channel drag means, as arithmetic (see CORD.md). A drag sets both
 * `armada.order` position and `armada.category` in ONE edition per channel.
 *
 * Invariant: after any drop, stored order matches rendered order exactly (the
 * whole rendered sequence is re-stamped), so the next drag reads indices straight
 * off the screen. The first drag in an unarranged community stamps every channel;
 * later drags only the disturbed run.
 */

import { categoryKey } from "@/concord/lib/channelCategory";
import { compareChannelOrder } from "@/concord/lib/channelOrder";

/** A channel as an arrangement sees it: an identity, a slot and a heading. */
export interface ArrangedChannel {
  idHex: string;
  position?: number;
  category?: string;
}

/** One channel's new metadata, for a caller that publishes one edition each. */
export interface ArrangementChange {
  idHex: string;
  position: number;
  category: string | undefined;
}

/**
 * Move `idHex` to `toIndex` of the RENDERED sequence (as the sidebar drew it),
 * under `category`. `toIndex` is the slot in the list WITHOUT the dragged channel,
 * so dropping on its own slot is a no-op.
 */
export function planChannelDrop(
  rendered: readonly ArrangedChannel[],
  idHex: string,
  toIndex: number,
  category: string | undefined,
): ArrangedChannel[] {
  const from = rendered.findIndex((c) => c.idHex === idHex);
  if (from === -1) return [...rendered];
  const without = rendered.filter((c) => c.idHex !== idHex);
  const at = Math.max(0, Math.min(toIndex, without.length));
  const moved: ArrangedChannel = { ...rendered[from], category };
  return [...without.slice(0, at), moved, ...without.slice(at)];
}

/**
 * The editions a planned arrangement implies — only genuinely changed channels.
 * Diffed against `before` (STORED state), since the dragged channel's planned
 * entry already carries its new category. Category compare is casefolded.
 */
export function arrangementChanges(
  before: readonly ArrangedChannel[],
  next: readonly ArrangedChannel[],
): ArrangementChange[] {
  const stored = new Map(before.map((c) => [c.idHex, c]));
  const out: ArrangementChange[] = [];
  next.forEach((channel, index) => {
    const category = channel.category?.trim() || undefined;
    const was = stored.get(channel.idHex);
    if (was && was.position === index && sameCategory(was.category, category)) return;
    out.push({ idHex: channel.idHex, position: index, category });
  });
  return out;
}

/** A planned arrangement held while its editions are still in flight. */
export type PendingArrangement = ReadonlyMap<
  string,
  { position: number; category: string | undefined }
>;

/** The whole plan as an overlay, for a caller that shows it before it lands. */
export function pendingFromPlan(plan: readonly ArrangedChannel[]): PendingArrangement {
  return new Map(
    plan.map((c, index) => [c.idHex, { position: index, category: c.category?.trim() || undefined }]),
  );
}

/**
 * Channels as they'll read once a pending arrangement lands, sorted by
 * `channelsView`'s comparator. An overlay: unnamed channels pass through.
 */
export function applyArrangement<T extends ArrangedChannel & { name: string }>(
  channels: readonly T[],
  pending: PendingArrangement | null,
): readonly T[] {
  if (!pending) return channels;
  return channels
    .map((c) => {
      const planned = pending.get(c.idHex);
      return planned ? { ...c, position: planned.position, category: planned.category } : c;
    })
    .sort(compareChannelOrder);
}

/**
 * Whether the fold now matches the arrangement, so the overlay must be dropped
 * (or it would mask later changes by others).
 */
export function arrangementSettled(
  channels: readonly ArrangedChannel[],
  pending: PendingArrangement,
): boolean {
  return channels.every((c) => {
    const planned = pending.get(c.idHex);
    return (
      !planned || (c.position === planned.position && sameCategory(c.category, planned.category))
    );
  });
}

/**
 * Whether two category names are the same bucket (casefolded, trimmed, blank =
 * uncategorized) — the rule `groupChannelsByCategory` uses.
 */
export function sameCategory(a: string | undefined, b: string | undefined): boolean {
  const ka = a?.trim() ? categoryKey(a) : "";
  const kb = b?.trim() ? categoryKey(b) : "";
  return ka === kb;
}
