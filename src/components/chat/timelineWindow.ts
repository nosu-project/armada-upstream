/** Sizing and anchoring for the timeline's bounded rendered window (see {@link MessageTimeline}). */

/**
 * Rows in the first commit after opening (~a viewport); the rest of
 * {@link INITIAL_WINDOW} follows a frame later. Row mounts are expensive, so
 * this sets how a channel switch feels.
 */
export const FIRST_PAINT_WINDOW = 12;

/** Rows rendered once a freshly-opened conversation has settled. */
export const INITIAL_WINDOW = 30;

export const WINDOW_STEP = 40;

/**
 * Past this, a window back at the bottom is trimmed to {@link INITIAL_WINDOW},
 * bounding DOM (iOS Safari's low memory ceiling) where it can't be noticed.
 */
export const TRIM_ABOVE = 200;

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
