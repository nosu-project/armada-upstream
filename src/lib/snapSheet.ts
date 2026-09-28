/**
 * SnapSheet math: a bottom sheet with peek/full rests whose drag hands off to
 * the list inside. Offsets are translateY px from full: `0` full, `peek`, `closed`.
 */

export type SnapStop = "full" | "peek" | "closed";

export interface SnapStops {
  peek: number;
  closed: number;
}

/** Past this speed (px/ms) a release is a fling and moves in its direction. */
export const FLING_VELOCITY = 0.4;

/** Fraction of the peek→closed run below peek past which a slow release dismisses. */
const DISMISS_FRACTION = 0.3;

/** Where a released sheet comes to rest. `velocity` is px/ms, positive downward. */
export function settleStop(offset: number, velocity: number, stops: SnapStops): SnapStop {
  if (velocity <= -FLING_VELOCITY) return "full";
  if (velocity >= FLING_VELOCITY) {
    // A fling down from above peek lands on peek (like Discord).
    return offset < stops.peek - 8 ? "peek" : "closed";
  }
  if (offset > stops.peek + (stops.closed - stops.peek) * DISMISS_FRACTION) return "closed";
  return offset < stops.peek / 2 ? "full" : "peek";
}

export function stopOffset(stop: SnapStop, stops: SnapStops): number {
  return stop === "full" ? 0 : stop === "peek" ? stops.peek : stops.closed;
}

/**
 * One drag move (`dy` > 0 = down). Up raises the sheet then scrolls the list
 * with leftover travel; down unscrolls the list first, then lowers the sheet.
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

/** Peek height: roughly keyboard height, like Discord's picker. */
export function peekHeight(viewport: number): number {
  return Math.round(Math.min(Math.max(viewport * 0.56, 340), viewport - 80));
}
