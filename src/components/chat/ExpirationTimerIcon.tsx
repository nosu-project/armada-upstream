/**
 * The disappearing-message clock: a ring losing a twelfth at a time as the hand
 * sweeps a turn. Artwork is generated from the constants below; dots sit ON the
 * ring with radius = half stroke, so they read as the arc's cap. Frame is
 * `ceil(fractionRemaining * 12)` and redraws are scheduled for the exact change.
 */

import { memo, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/** Frames in the strip (0 = empty, 12 = full), one per twelfth of the life. */
export const LAST_FRAME = 12;

const CENTER = 6;
/**
 * Sized to the PIXEL GRID at 12 CSS px: radius 5.5 with a 1-unit stroke puts
 * the edges on whole pixels at the cardinal points; off-grid radii smear.
 */
const RING_R = 5.5;
const STROKE = 1;
/** Half the stroke, so a dot is exactly the cap the arc would have had. */
const DOT_R = STROKE / 2;
const HAND_R = 3.5;
/** Hub wider than the hand cap's overshoot, which would read as off-centre. */
const HUB_R = 0.8;

const n = (v: number) => Number(v.toFixed(3)).toString();

/** A point `deg` counterclockwise from 12 o'clock, `r` out from the centre. */
function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CENTER - r * Math.sin(rad), CENTER - r * Math.cos(rad)];
}

const pt = (deg: number, r: number) => polar(deg, r).map(n).join(" ");

/** Time still to run: arc from the hand counterclockwise to 12 o'clock. */
function ringPath(frame: number): string {
  if (frame <= 0) return "";
  // An arc that starts where it ends draws nothing, so use two half turns.
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

/** A full turn over the lifetime: up when fresh, 6 o'clock at halfway. */
function handPath(frame: number): string {
  return `M ${CENTER} ${CENTER} L ${pt((1 - frame / LAST_FRAME) * 360, HAND_R)}`;
}

/** One frame's three strokes. `ring` is empty at 0, `dots` at {@link LAST_FRAME}. */
export interface TimerFrame {
  ring: string;
  dots: string;
  hand: string;
}

export const TIMER_FRAMES: readonly TimerFrame[] = Array.from(
  { length: LAST_FRAME + 1 },
  (_, frame) => ({
    ring: ringPath(frame),
    dots: dotsPath(frame),
    hand: handPath(frame),
  }),
);

interface ExpirationTimerIconProps {
  /** The message's own `created_at` (seconds). */
  createdAt: number;
  /** The NIP-40 deadline (seconds). */
  expiresAt: number;
  className?: string;
}

/** The frame for a given instant: 12 when untouched, 0 once the deadline passes. */
export function frameAt(createdAt: number, expiresAt: number, nowMs: number): number {
  const total = expiresAt - createdAt;
  // No runway: show empty rather than divide by zero.
  if (total <= 0) return 0;
  const remaining = expiresAt - nowMs / 1000;
  return Math.max(0, Math.min(LAST_FRAME, Math.ceil((remaining / total) * LAST_FRAME)));
}

/** Epoch ms when `frame` gives way to `frame - 1`; scheduled rather than polled. */
export function nextFrameChangeMs(createdAt: number, expiresAt: number, frame: number): number | undefined {
  if (frame <= 0) return undefined;
  const total = expiresAt - createdAt;
  if (total <= 0) return undefined;
  return (expiresAt - ((frame - 1) / LAST_FRAME) * total) * 1000;
}

/** A live disappearing-message clock in `currentColor`. */
export const ExpirationTimerIcon = memo(function ExpirationTimerIcon({
  createdAt,
  expiresAt,
  className,
}: ExpirationTimerIconProps) {
  const [frame, setFrame] = useState(() => frameAt(createdAt, expiresAt, Date.now()));

  useEffect(() => {
    // Re-derive on every settle: a backgrounded tab may have skipped boundaries.
    const current = frameAt(createdAt, expiresAt, Date.now());
    setFrame(current);
    const at = nextFrameChangeMs(createdAt, expiresAt, current);
    if (at === undefined) return;
    // +50ms past the boundary; exactly on it would re-arm a zero timeout forever.
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
      {/* Butt caps: the arc must end ON its twelfth, where the next dot is. */}
      {ring && <path d={ring} />}
      {dots && <path d={dots} fill="currentColor" stroke="none" />}
      <path d={hand} strokeLinecap="round" />
      <circle cx={CENTER} cy={CENTER} r={HUB_R} fill="currentColor" stroke="none" />
    </svg>
  );
});
