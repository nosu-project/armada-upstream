/**
 * Sizing and anchoring for the chat timeline's rendered window.
 *
 * The timeline renders a bounded slice of the transport's loaded history rather
 * than virtualizing it (see {@link MessageTimeline}); these are the numbers that
 * decide how much of it is in the DOM, and the rule for where the slice starts.
 */

/**
 * Rows in the *first* commit after a conversation opens — roughly a viewport.
 * The rest of {@link INITIAL_WINDOW} is added a frame later, off the critical
 * path: a row is an expensive mount (author query, content tokenization, media
 * and embed subtrees), so what a channel switch feels like is set by how many
 * of them land in one synchronous commit, not by how many end up mounted.
 */
export const FIRST_PAINT_WINDOW = 12;

/** Rows rendered once a freshly-opened conversation has settled. */
export const INITIAL_WINDOW = 30;

/** Extra already-loaded messages revealed each time the reader nears the top. */
export const WINDOW_STEP = 40;

/**
 * Once the rendered window has grown past this and the reader is back at the
 * bottom, it is trimmed to {@link INITIAL_WINDOW}. Keeps a long session's DOM
 * bounded (iOS Safari has a low per-tab memory ceiling) and does it at the one
 * moment where dropping rows far above the viewport can't be noticed.
 */
export const TRIM_ABOVE = 200;

/**
 * Where the rendered window starts in the full loaded history.
 *
 * The window is anchored to a message ID rather than a count so that appends
 * (a new message arriving) grow it at the bottom instead of silently dropping a
 * row off the top, and so that a backfill prepend leaves it pointing at the
 * same message. `anchorLost` means the anchor message is no longer in the
 * history at all — a conversation switch, or a transport that dropped the
 * front — and the caller should fall back to the newest `initial` messages and
 * re-pin to the bottom.
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

/**
 * Step the window back by `rows` RENDERED rows from `startIndex`, folding runs
 * counting as one apiece.
 *
 * Same argument as {@link resolveWindowStart}'s, one scroll gesture at a time:
 * a reader who scrolls up through a wall of spam is asking for more
 * conversation, and a step measured in messages hands them one more collapsed
 * line instead. Returns the new start index.
 */
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
    // The row is new unless the entry BELOW it is folded too, in which case
    // this one is already inside that row. `i + 1` may be past the end when the
    // step starts at the newest entry — there is no row below it then.
    const below = i + 1 < entries.length ? entries[i + 1] : undefined;
    if (!folded(entries[i]) || !below || !folded(below)) counted++;
    if (counted >= rows) break;
  }
  return Math.max(0, i);
}

/**
 * Where a window of `initial` ROWS starts, which is not the same as `initial`
 * messages once some of them collapse.
 *
 * A flood folds into a single row (`floodCluster.ts`), so counting its members
 * against the budget spends a whole viewport on one collapsed line and pushes
 * the actual conversation out of the rendered slice — the reader opens the
 * channel, sees "94 similar messages" and two sentences, and has to scroll up
 * through history that was already loaded to find the room they were in. A run
 * of folded messages therefore costs what it renders: one.
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
    // Only the first member of a run (scanning backwards, its LAST message)
    // pays; the rest are inside a row already counted.
    if (!isFolded || i === messages.length - 1 || !folded(messages[i + 1])) rows++;
    if (rows > initial) break;
  }
  return Math.max(0, i + 1);
}
