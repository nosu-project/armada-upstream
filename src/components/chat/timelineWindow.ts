/** Sizing and anchoring for the timeline's bounded rendered window (see {@link MessageTimeline}). */

/**
 * Rows in the first commit after opening (~a viewport); the rest of
 * {@link INITIAL_WINDOW} follows a frame later. Row mounts are expensive, so
 * this sets how a channel switch feels.
 */
export const FIRST_PAINT_WINDOW = 12;

/** Rows rendered once a freshly-opened conversation has settled. */
export const INITIAL_WINDOW = 30;

/** Rows revealed per step: small, since each step's mount is one main-thread stall mid-fling. */
export const WINDOW_STEP = 16;

/**
 * Past this, a window back at the bottom is trimmed to {@link INITIAL_WINDOW},
 * bounding DOM (iOS Safari's low memory ceiling) where it can't be noticed.
 */
export const TRIM_ABOVE = 200;

/**
 * Rows a window scrolled away from the bottom keeps. Revealing past it drops
 * the far edge, so reading back through history holds a bounded DOM.
 */
export const MAX_WINDOW = 240;

/** Over-run tolerated before trimming, so the far edge moves in batches (each trim above the reader is a scroll write). */
export const TRIM_SLACK = 4 * WINDOW_STEP;

/** Rendered rows in `[from, to)` (a folded run counts as one). */
export function countRows<T>(
  entries: readonly T[],
  from: number,
  to: number,
  folded?: (entry: T) => boolean,
): number {
  if (!folded) return Math.max(0, to - from);
  let rows = 0;
  for (let i = Math.max(0, from); i < Math.min(to, entries.length); i++) {
    if (!folded(entries[i]) || i === from || !folded(entries[i - 1])) rows++;
  }
  return rows;
}

/**
 * Step forward `rows` RENDERED rows from `fromIndex`. Returns the exclusive end
 * index, which never splits a folded run.
 */
export function stepForwardRows<T>(
  entries: readonly T[],
  fromIndex: number,
  rows: number = WINDOW_STEP,
  folded?: (entry: T) => boolean,
): number {
  if (!folded) return Math.min(entries.length, Math.max(0, fromIndex) + rows);
  let counted = 0;
  let i = Math.max(0, fromIndex);
  for (; i < entries.length; i++) {
    if (!folded(entries[i]) || i === fromIndex || !folded(entries[i - 1])) {
      if (counted >= rows) break;
      counted++;
    }
  }
  return i;
}

/**
 * Exclusive window end, anchored by the id of its newest rendered entry.
 * `null` = the newest loaded entry, so appends render. A lost anchor keeps the
 * window bounded at `maxRows` from its start rather than reaching to the newest.
 */
export function resolveWindowEnd<T extends { id: string }>(
  entries: readonly T[],
  endId: string | null,
  startIndex: number,
  maxRows: number = MAX_WINDOW,
  folded?: (entry: T) => boolean,
): number {
  if (endId === null) return entries.length;
  const index = entries.findIndex((entry) => entry.id === endId);
  if (index >= startIndex) return index + 1;
  return stepForwardRows(entries, startIndex, maxRows, folded);
}

/**
 * Window start in the loaded history, anchored by message ID so appends grow it
 * and prepends keep it. `anchorLost`: the anchor is gone (conversation switch);
 * fall back to the newest `initial` and re-pin.
 */
export function resolveWindowStart<T extends { id: string }>(
  messages: readonly T[],
  startId: string | null,
  initial: number = INITIAL_WINDOW,
  folded?: (message: T) => boolean,
): { startIndex: number; anchorLost: boolean } {
  const tail = tailStart(messages, initial, folded);
  if (messages.length === 0) return { startIndex: 0, anchorLost: false };
  if (startId === null) return { startIndex: tail, anchorLost: false };
  const index = messages.findIndex((m) => m.id === startId);
  if (index === -1) return { startIndex: tail, anchorLost: true };
  return { startIndex: index, anchorLost: false };
}

/** Step back `rows` RENDERED rows (a folded run counts as one). Returns the new start index. */
export function stepBackRows<T extends { id: string }>(
  entries: readonly T[],
  startIndex: number,
  rows: number = WINDOW_STEP,
  folded?: (entry: T) => boolean,
): number {
  if (!folded) return Math.max(0, startIndex - rows);
  let counted = 0;
  let i = Math.min(startIndex, entries.length) - 1;
  for (; i >= 0; i--) {
    // Only a new row unless the entry below is folded too (already inside that row).
    const below = i + 1 < entries.length ? entries[i + 1] : undefined;
    if (!folded(entries[i]) || !below || !folded(below)) counted++;
    if (counted >= rows) break;
  }
  return Math.max(0, i);
}

/**
 * Start of a window of `initial` ROWS: a folded flood (`floodCluster.ts`) costs
 * one row, or spam would push the conversation out of the slice.
 */
function tailStart<T extends { id: string }>(
  messages: readonly T[],
  initial: number,
  folded?: (message: T) => boolean,
): number {
  if (!folded) return Math.max(0, messages.length - initial);
  let rows = 0;
  let i = messages.length - 1;
  for (; i >= 0; i--) {
    const isFolded = folded(messages[i]);
    // Only the run's first member (scanning backwards) counts.
    if (!isFolded || i === messages.length - 1 || !folded(messages[i + 1])) rows++;
    if (rows > initial) break;
  }
  return Math.max(0, i + 1);
}
