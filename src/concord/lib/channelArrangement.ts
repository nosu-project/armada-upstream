/**
 * What a channel drag means, as arithmetic (see CORD.md).
 *
 * Two conventions decide where a channel sits: `armada.order`'s position and
 * `armada.category`'s name. A drag sets BOTH at once — you drop a channel at a
 * spot, and the spot is inside some category or none — so the two have to be
 * planned together and published in ONE edition per channel. Publishing them
 * separately would be two editions on the same entity for one gesture, and a
 * failure between them leaves a channel filed where it isn't positioned.
 *
 * The invariant this establishes, and the reason a drag is expressible at all:
 * AFTER any drop, the stored order matches the rendered order exactly.
 * `groupChannelsByCategory` buckets a flat list, so a category's members need
 * not be contiguous in it — two channels in "Voice" can have three
 * uncategorized channels positioned between them, and the sidebar still draws
 * them together. That is fine to READ, but it means "the row above where I
 * dropped" has no stable flat index. Re-stamping the whole rendered sequence
 * on every drop collapses the two orders into one, so the next drag can read
 * an index straight off the screen.
 *
 * The cost is honest and bounded: the first drag in a community that has never
 * been arranged stamps every channel (an arrangement isn't expressible until
 * each carries a position — the same thing `reorderPositions` says), and later
 * drags stamp only the run between the old and new slot.
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
 * Move `idHex` to `toIndex` of the RENDERED sequence, under `category`.
 *
 * `rendered` is what the sidebar drew, in the order it drew it (the
 * uncategorized run, then each category's channels) — so `toIndex` is read
 * straight off the pointer without translating between two orders.
 *
 * `toIndex` is the slot in the list WITHOUT the dragged channel, which is what
 * a drop indicator between two rows actually names; dropping a channel back on
 * its own slot is therefore a no-op rather than an off-by-one.
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
 * The editions a planned arrangement implies: index becomes position, and each
 * channel keeps the category its slot puts it in. Only genuinely-changed
 * channels come back, so a drop within a category republishes the run it
 * disturbed rather than the whole sidebar.
 *
 * Diffed against `before` (the STORED state) rather than read off `next`
 * alone, because the dragged channel's planned entry already carries its new
 * category — comparing that to itself would silently drop the one edition the
 * gesture was for whenever the drop didn't also change its index.
 *
 * Category comparison is casefolded, so re-filing under a spelling that only
 * differs in case isn't mistaken for a change: the grouping would be
 * identical and the edition would be noise.
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
 * The channels as they will read once a pending arrangement lands: the plan
 * laid over what the fold says, sorted by the same comparator `channelsView`
 * sorts by so the optimistic sidebar and the confirmed one cannot disagree
 * about order. Channels the plan doesn't name are passed through — it is an
 * overlay, not a replacement, so one that has gone stale against a channel
 * created meanwhile still renders that channel.
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
 * Whether the fold now says what the arrangement asked for, in which case the
 * overlay must be dropped — holding it any longer would mask a later change
 * by someone else behind a drop of ours that has already landed.
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
 * Whether two category names mean the same bucket. Casefolded and
 * trim-insensitive, and blank is the uncategorized run — the same rule
 * `groupChannelsByCategory` groups by, so "is this arrangement the one I
 * asked for" and "does it render the same" cannot disagree.
 */
export function sameCategory(a: string | undefined, b: string | undefined): boolean {
  const ka = a?.trim() ? categoryKey(a) : "";
  const kb = b?.trim() ? categoryKey(b) : "";
  return ka === kb;
}
