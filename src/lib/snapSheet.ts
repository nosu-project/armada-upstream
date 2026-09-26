/**
 * The arithmetic behind SnapSheet: a bottom sheet with two resting heights
 * (peek and full) whose drag hands off to, and back from, the list inside it.
 *
 * Offsets are the sheet's translateY in pixels from its fully expanded
 * position: `0` is full, `peek` is the half-height rest, `closed` is entirely
 * below the screen.
 */

export type SnapStop = "full" | "peek" | "closed";

export interface SnapStops {
  peek: number;
  closed: number;
}

/** Past this speed (px/ms) a release is a fling and moves in its direction. */
export const FLING_VELOCITY = 0.4;

/**
 * How far below peek, as a fraction of the peek-to-closed run, a slow release
 * still dismisses. Under half: a sheet already pulled most of the way down
 * reads as "going", not as a spring back.
 */
const DISMISS_FRACTION = 0.3;

/** Where a released sheet comes to rest. `velocity` is px/ms, positive downward. */
export function settleStop(offset: number, velocity: number, stops: SnapStops): SnapStop {
  if (velocity <= -FLING_VELOCITY) return "full";
  if (velocity >= FLING_VELOCITY) {
    // A fling down from above peek lands on peek, as Discord's does; only one
    // that starts at or below it leaves.
    return offset < stops.peek - 8 ? "peek" : "closed";
  }
  if (offset > stops.peek + (stops.closed - stops.peek) * DISMISS_FRACTION) return "closed";
  return offset < stops.peek / 2 ? "full" : "peek";
}

export function stopOffset(stop: SnapStop, stops: SnapStops): number {
  return stop === "full" ? 0 : stop === "peek" ? stops.peek : stops.closed;
}

/**
 * One move of a drag the sheet owns, `dy` positive for a finger moving down.
 *
 * Up: the sheet rises until full and whatever travel is left scrolls the list,
 * so one continuous swipe opens the sheet and keeps going into the grid.
 * Down: the list scrolls back to its top first and only then does the sheet
 * follow — the same gesture reversed.
 */
export function dragStep(
  offset: number,
  scrollTop: number,
  dy: number,
  closed: number,
): { offset: number; scrollTop: number } {
  if (dy < 0) {
    const rise = Math.min(offset, -dy);
    return { offset: offset - rise, scrollTop: scrollTop + (-dy - rise) };
  }
  const unscroll = Math.min(scrollTop, dy);
  return { offset: Math.min(closed, offset + dy - unscroll), scrollTop: scrollTop - unscroll };
}

/** How expanded the sheet is between peek (0) and full (1). */
export function expansion(offset: number, stops: SnapStops): number {
  if (stops.peek <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - offset / stops.peek));
}

/** How present the sheet is between closed (0) and peek (1), for the scrim. */
export function presence(offset: number, stops: SnapStops): number {
  const run = stops.closed - stops.peek;
  if (run <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - (offset - stops.peek) / run));
}

/**
 * The peek height: about the height of a keyboard, which is where Discord's
 * picker sits — enough for two rows of the camera roll and the action tiles
 * while the conversation stays visible above.
 */
export function peekHeight(viewport: number): number {
  return Math.round(Math.min(Math.max(viewport * 0.56, 340), viewport - 80));
}
