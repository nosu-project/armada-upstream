/**
 * The disappearing-message clock: a ring that gives up a twelfth at a time
 * while the hand sweeps a full turn, ending as a bare ring of dots the instant
 * before the message vanishes.
 *
 * The artwork is GENERATED from the constants below rather than authored as 13
 * path strings. The frames differ only in one arc length, one dot count and
 * one angle, so the drawing is a handful of numbers and the strip is derived
 * once at module load. Two of those numbers carry the design: a dot's radius is
 * half the stroke width and the dots sit ON the ring, so the dot at 12 o'clock
 * reads as the round cap of the arc's fixed end rather than as a collision.
 *
 * Frames run empty (index 0) to full (index 12): the frame is
 * `ceil(fractionRemaining * 12)`, and the NEXT REDRAW is scheduled for the
 * exact moment that changes. With only 13 states a poll mostly repaints
 * identical pixels, and a thread can hold hundreds of these at once.
 */

import { memo, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/** Frames in the strip (0 = empty, 12 = full), one per twelfth of the life. */
export const LAST_FRAME = 12;

/** The 12x12 viewport's centre. */
const CENTER = 6;
/**
 * Where the ring runs, and where the dots that replace it sit. These two are
 * sized to the PIXEL GRID, not to taste: the icon renders at 12 CSS px, and a
 * ring at radius 5.5 with a 1-unit stroke puts the stroke's edges 5 and 6
 * units from centre, so at the cardinal points the axis-aligned band covers
 * exactly one pixel row or column. Any off-grid radius smears those points
 * across two half-covered pixels, worst at 3 and 9 o'clock where nothing
 * else overlaps the ring to hide it.
 */
const RING_R = 5.5;
const STROKE = 1;
/** Half the stroke, so a dot is exactly the cap the arc would have had. */
const DOT_R = STROKE / 2;
const HAND_R = 3.5;
/**
 * The pivot hub. The hand's round cap overshoots the centre by half the
 * stroke on the side away from the tip, which reads as the hand sitting
 * slightly off centre; a hub wider than that overshoot hides it and gives the
 * hand a spindle to turn on.
 */
const HUB_R = 0.8;

/** Trim float noise so the emitted path data stays short. */
const n = (v: number) => Number(v.toFixed(3)).toString();

/** A point `deg` counterclockwise from 12 o'clock, `r` out from the centre. */
function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CENTER - r * Math.sin(rad), CENTER - r * Math.cos(rad)];
}

const pt = (deg: number, r: number) => polar(deg, r).map(n).join(" ");

/**
 * The time still to run: an arc from the depletion boundary (where the hand
 * points) counterclockwise round to 12 o'clock. The boundary advances
 * counterclockwise as the twelfths are spent, so the arc, the dots and the
 * hand all move together.
 */
function ringPath(frame: number): string {
  if (frame <= 0) return "";
  // A full turn has no two endpoints to name (an arc command that starts where
  // it ends draws nothing at all), so the whole ring is two half turns.
  if (frame >= LAST_FRAME) {
    return `M ${pt(0, RING_R)} A ${RING_R} ${RING_R} 0 1 0 ${pt(180, RING_R)}` +
      ` A ${RING_R} ${RING_R} 0 1 0 ${pt(0, RING_R)}`;
  }
  const sweep = (frame / LAST_FRAME) * 360;
  return `M ${pt(360 - sweep, RING_R)} A ${RING_R} ${RING_R} 0 ${sweep > 180 ? 1 : 0} 0 ${pt(360, RING_R)}`;
}

/** The twelfths already spent: dots from 12 o'clock counterclockwise to the hand. */
function dotsPath(frame: number): string {
  const dots: string[] = [];
  for (let i = 0; i < LAST_FRAME - frame; i++) {
    const [cx, cy] = polar(i * (360 / LAST_FRAME), RING_R);
    dots.push(
      `M ${n(cx - DOT_R)} ${n(cy)} a ${DOT_R} ${DOT_R} 0 1 0 ${n(DOT_R * 2)} 0` +
        ` a ${DOT_R} ${DOT_R} 0 1 0 ${n(-DOT_R * 2)} 0Z`,
    );
  }
  return dots.join(" ");
}

/**
 * The hand, a full turn over the message's lifetime: straight up when it lands
 * (frame 12), pointing at 6 o'clock when half the time is gone, back up as the
 * last of it runs out.
 */
function handPath(frame: number): string {
  return `M ${CENTER} ${CENTER} L ${pt((1 - frame / LAST_FRAME) * 360, HAND_R)}`;
}

/** One frame's three strokes. `ring` is empty at 0, `dots` at {@link LAST_FRAME}. */
export interface TimerFrame {
  ring: string;
  dots: string;
  hand: string;
}

/** The 13 depletion frames, emptiest first. */
export const TIMER_FRAMES: readonly TimerFrame[] = Array.from(
  { length: LAST_FRAME + 1 },
  (_, frame) => ({
    ring: ringPath(frame),
    dots: dotsPath(frame),
    hand: handPath(frame),
  }),
);

interface ExpirationTimerIconProps {
  /** When the countdown started — the message's own `created_at` (seconds). */
  createdAt: number;
  /** The NIP-40 deadline (seconds). */
  expiresAt: number;
  className?: string;
}

/** The frame for a given instant: 12 when untouched, 0 once the deadline passes. */
export function frameAt(createdAt: number, expiresAt: number, nowMs: number): number {
  const total = expiresAt - createdAt;
  // A deadline at or before the send time has no runway to animate over; show
  // the empty face rather than dividing by zero.
  if (total <= 0) return 0;
  const remaining = expiresAt - nowMs / 1000;
  return Math.max(0, Math.min(LAST_FRAME, Math.ceil((remaining / total) * LAST_FRAME)));
}

/**
 * The instant `frame` gives way to `frame - 1`, in epoch ms. Scheduling on this
 * rather than polling means one timer per icon per VISIBLE state change: a
 * 4-week timer redraws 12 times in four weeks, a 30-second one every 2.5s.
 */
export function nextFrameChangeMs(createdAt: number, expiresAt: number, frame: number): number | undefined {
  if (frame <= 0) return undefined;
  const total = expiresAt - createdAt;
  if (total <= 0) return undefined;
  // frame drops when remaining falls to (frame - 1)/12 of the total.
  return (expiresAt - ((frame - 1) / LAST_FRAME) * total) * 1000;
}

/**
 * A live disappearing-message clock. Renders as `currentColor`, so it inherits
 * the muted tone of whatever row it sits in.
 */
export const ExpirationTimerIcon = memo(function ExpirationTimerIcon({
  createdAt,
  expiresAt,
  className,
}: ExpirationTimerIconProps) {
  const [frame, setFrame] = useState(() => frameAt(createdAt, expiresAt, Date.now()));

  useEffect(() => {
    // Re-derive on every settle: props may have changed, and a tab that was
    // backgrounded past several boundaries must not resume from a stale frame.
    const current = frameAt(createdAt, expiresAt, Date.now());
    setFrame(current);
    const at = nextFrameChangeMs(createdAt, expiresAt, current);
    if (at === undefined) return;
    // +50ms so the timer fires just PAST the boundary; landing exactly on it
    // recomputes the same frame and re-arms a zero-length timeout, spinning.
    const delay = Math.min(Math.max(at - Date.now(), 0) + 50, 2 ** 31 - 1);
    const id = setTimeout(() => setFrame(frameAt(createdAt, expiresAt, Date.now())), delay);
    return () => clearTimeout(id);
  }, [createdAt, expiresAt, frame]);

  const { ring, dots, hand } = TIMER_FRAMES[frame];

  return (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      aria-hidden
      className={cn("size-3 shrink-0", className)}
    >
      {/* Butt caps: the arc must end ON its twelfth, since the next dot is there. */}
      {ring && <path d={ring} />}
      {dots && <path d={dots} fill="currentColor" stroke="none" />}
      <path d={hand} strokeLinecap="round" />
      <circle cx={CENTER} cy={CENTER} r={HUB_R} fill="currentColor" stroke="none" />
    </svg>
  );
});
