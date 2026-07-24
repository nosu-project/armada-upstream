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
export function resolveWindowStart(
  messages: readonly { id: string }[],
  startId: string | null,
  initial: number = INITIAL_WINDOW,
): { startIndex: number; anchorLost: boolean } {
  const tail = Math.max(0, messages.length - initial);
  if (messages.length === 0) return { startIndex: 0, anchorLost: false };
  if (startId === null) return { startIndex: tail, anchorLost: false };
  const index = messages.findIndex((m) => m.id === startId);
  if (index === -1) return { startIndex: tail, anchorLost: true };
  return { startIndex: index, anchorLost: false };
}
