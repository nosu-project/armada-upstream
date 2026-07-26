/**
 * Signal's disappearing-message timer: a clock whose ring depletes and whose
 * hand sweeps a full turn over the message's lifetime, ending as a bare ring of
 * dots the instant before it vanishes.
 *
 * ARTWORK PROVENANCE. The 13 frames below are the `ic_timer_NN_12` vector
 * drawables from Signal-Android (github.com/signalapp/Signal-Android,
 * `app/src/main/res/drawable/`), Copyright (C) Signal Messenger, LLC, used
 * under the GNU Affero General Public License v3. They are copied verbatim:
 * each Android `<vector>` carried a single `android:pathData`, reproduced here
 * unchanged as an SVG `d` on the same 12x12 viewport. Armada is AGPL-3.0 too,
 * so the copy is license-compatible; see the README's License section.
 * Nothing about the geometry is ours — only the frame selection and the
 * scheduling below.
 *
 * Frames run empty (index 0) to full (index 12). Signal picks the frame with
 * `ceil(fractionRemaining * 12)` and redraws on a 1s timer (50ms in the last
 * 30s). We pick the same frame but schedule the NEXT REDRAW for the exact
 * moment the frame changes — with only 13 states a poll mostly repaints
 * identical pixels, and a thread can hold hundreds of these at once.
 */

import { memo, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/** The 13 depletion frames, emptiest first. Verbatim Signal path geometry. */
export const TIMER_FRAMES: readonly string[] = [
  "M6.75,6a0.75,0.75 0,0 1,-1.5 0c0,-0.414 0.475,-3.581 0.5,-3.75S5.862,2 6,2s0.226,0.087 0.25,0.25S6.75,5.589 6.75,6ZM5.375,0.625A0.625,0.625 0,1 0,6 0,0.625 0.625,0 0,0 5.375,0.625ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM10.75,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,10.75 6ZM5.375,11.375A0.625,0.625 0,1 0,6 10.75,0.625 0.625,0 0,0 5.375,11.375ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM10.03,3.312a0.625,0.625 0,1 0,0.625 -0.624A0.626,0.626 0,0 0,10.03 3.312ZM8.062,10.655a0.625,0.625 0,1 0,0.626 -0.625A0.625,0.625 0,0 0,8.062 10.655ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM2.688,10.655a0.625,0.625 0,1 0,0.625 -0.625A0.624,0.624 0,0 0,2.688 10.655ZM8.063,1.345A0.625,0.625 0,1 0,8.688 0.72,0.624 0.624,0 0,0 8.063,1.345ZM10.03,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,10.03 8.687Z",
  "M6.65,6.375a0.75,0.75 0,0 1,-1.3 -0.75c0.208,-0.359 2.2,-2.864 2.308,-3a0.25,0.25 0,0 1,0.434 0.25C8.034,3.022 6.855,6.019 6.65,6.375ZM9.183,1.486A0.5,0.5 0,0 0,9 0.8,6 6,0 0,0 6,0 0.5,0.5 0,0 0,6 1a5,5 0,0 1,2.5 0.668,0.493 0.493,0 0,0 0.25,0.068A0.5,0.5 0,0 0,9.183 1.486ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM10.75,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,10.75 6ZM5.375,11.375A0.625,0.625 0,1 0,6 10.75,0.625 0.625,0 0,0 5.375,11.375ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM10.03,3.312a0.625,0.625 0,1 0,0.625 -0.624A0.626,0.626 0,0 0,10.03 3.312ZM8.062,10.655a0.625,0.625 0,1 0,0.626 -0.625A0.625,0.625 0,0 0,8.062 10.655ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM2.688,10.655a0.625,0.625 0,1 0,0.625 -0.625A0.624,0.624 0,0 0,2.688 10.655ZM10.03,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,10.03 8.687Z",
  "M6.375,6.65a0.75,0.75 0,0 1,-0.75 -1.3c0.359,-0.207 3.339,-1.379 3.5,-1.442A0.245,0.245 0,0 1,9.464 4a0.25,0.25 0,0 1,-0.091 0.342C9.251,4.439 6.731,6.444 6.375,6.65ZM11.014,3.682A0.5,0.5 0,0 0,11.2 3,6.021 6.021,0 0,0 6,0 0.5,0.5 0,0 0,6 1a5.021,5.021 0,0 1,4.331 2.5,0.5 0.5,0 0,0 0.433,0.25A0.49,0.49 0,0 0,11.014 3.682ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM10.75,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,10.75 6ZM5.375,11.375A0.625,0.625 0,1 0,6 10.75,0.625 0.625,0 0,0 5.375,11.375ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM8.062,10.655a0.625,0.625 0,1 0,0.626 -0.625A0.625,0.625 0,0 0,8.062 10.655ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM2.688,10.655a0.625,0.625 0,1 0,0.625 -0.625A0.624,0.624 0,0 0,2.688 10.655ZM10.03,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,10.03 8.687Z",
  "M6,6.75a0.75,0.75 0,0 1,0 -1.5c0.414,0 3.581,0.475 3.75,0.5S10,5.862 10,6s-0.087,0.226 -0.25,0.25S6.411,6.75 6,6.75ZM12,6A6.006,6.006 0,0 0,6 0,0.5 0.5,0 0,0 6,1a5.006,5.006 0,0 1,5 5,0.5 0.5,0 0,0 1,0ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM5.375,11.375A0.625,0.625 0,1 0,6 10.75,0.625 0.625,0 0,0 5.375,11.375ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM8.062,10.655a0.625,0.625 0,1 0,0.626 -0.625A0.625,0.625 0,0 0,8.062 10.655ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM2.688,10.655a0.625,0.625 0,1 0,0.625 -0.625A0.624,0.624 0,0 0,2.688 10.655ZM10.03,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,10.03 8.687Z",
  "M5.625,6.65a0.75,0.75 0,0 1,0.75 -1.3c0.359,0.208 2.864,2.2 3,2.308a0.25,0.25 0,0 1,-0.25 0.434C8.978,8.034 5.981,6.855 5.625,6.65ZM11.2,9A6,6 0,0 0,6 0,0.5 0.5,0 0,0 6,1a5,5 0,0 1,4.331 7.5A0.5,0.5 0,0 0,11.2 9ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM5.375,11.375A0.625,0.625 0,1 0,6 10.75,0.625 0.625,0 0,0 5.375,11.375ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM8.062,10.655a0.625,0.625 0,1 0,0.626 -0.625A0.625,0.625 0,0 0,8.062 10.655ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM2.688,10.655a0.625,0.625 0,1 0,0.625 -0.625A0.624,0.624 0,0 0,2.688 10.655Z",
  "M5.35,6.375a0.75,0.75 0,0 1,1.3 -0.75c0.207,0.359 1.379,3.339 1.442,3.5A0.245,0.245 0,0 1,8 9.464a0.25,0.25 0,0 1,-0.342 -0.091C7.561,9.251 5.556,6.731 5.35,6.375ZM9,11.2A6,6 0,0 0,6 0,0.5 0.5,0 0,0 6,1a5,5 0,0 1,2.5 9.332A0.5,0.5 0,1 0,9 11.2ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM5.375,11.375A0.625,0.625 0,1 0,6 10.75,0.625 0.625,0 0,0 5.375,11.375ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM2.688,10.655a0.625,0.625 0,1 0,0.625 -0.625A0.624,0.624 0,0 0,2.688 10.655Z",
  "M5.25,6a0.75,0.75 0,0 1,1.5 0c0,0.414 -0.475,3.581 -0.5,3.75S6.138,10 6,10s-0.226,-0.087 -0.25,-0.25S5.25,6.411 5.25,6ZM12,6A6.006,6.006 0,0 0,6 0,0.5 0.5,0 0,0 6,1 5,5 0,0 1,6 11a0.5,0.5 0,0 0,0 1A6.006,6.006 0,0 0,12 6ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM2.688,10.655a0.625,0.625 0,1 0,0.625 -0.625A0.624,0.624 0,0 0,2.688 10.655Z",
  "M5.35,5.625a0.75,0.75 0,1 1,1.3 0.75c-0.208,0.359 -2.2,2.864 -2.308,3a0.25,0.25 0,0 1,-0.434 -0.25C3.966,8.978 5.145,5.981 5.35,5.625ZM12,6A6.006,6.006 0,0 0,6 0,0.5 0.5,0 0,0 6,1a5,5 0,1 1,-2.5 9.332A0.5,0.5 0,1 0,3 11.2,6 6,0 0,0 12,6ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,8.687a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 8.687ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312Z",
  "M5.625,5.35a0.75,0.75 0,1 1,0.75 1.3c-0.359,0.207 -3.339,1.379 -3.5,1.442A0.245,0.245 0,0 1,2.536 8a0.25,0.25 0,0 1,0.091 -0.342C2.749,7.561 5.269,5.556 5.625,5.35ZM0,6a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0 6ZM2.688,1.345A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM12,6A6.006,6.006 0,0 0,6 0,0.5 0.5,0 0,0 6,1 5,5 0,1 1,1.669 8.5,0.5 0.5,0 0,0 0.8,9 6,6 0,0 0,12 6Z",
  "M6,5.25a0.75,0.75 0,0 1,0 1.5c-0.414,0 -3.581,-0.475 -3.75,-0.5S2,6.138 2,6s0.087,-0.226 0.25,-0.25S5.589,5.25 6,5.25ZM2.688,1.35A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM0.72,3.312a0.625,0.625 0,1 0,0.625 -0.625A0.625,0.625 0,0 0,0.72 3.312ZM12,6A6.006,6.006 0,0 0,6 0,0.5 0.5,0 0,0 6,1 5,5 0,1 1,1 6,0.5 0.5,0 0,0 0,6 6,6 0,0 0,12 6Z",
  "M6.375,5.35a0.75,0.75 0,1 1,-0.75 1.3c-0.359,-0.208 -2.864,-2.2 -3,-2.308a0.25,0.25 0,0 1,0.25 -0.434C3.022,3.966 6.019,5.145 6.375,5.35ZM2.688,1.35A0.625,0.625 0,1 0,3.313 0.72,0.624 0.624,0 0,0 2.688,1.345ZM12,6A6.006,6.006 0,0 0,6 0,0.5 0.5,0 0,0 6,1 5,5 0,1 1,1.669 3.5,0.5 0.5,0 1,0 0.8,3 6,6 0,1 0,12 6Z",
  "M6.65,5.625a0.75,0.75 0,0 1,-1.3 0.75c-0.207,-0.359 -1.379,-3.339 -1.442,-3.5A0.245,0.245 0,0 1,4 2.536a0.25,0.25 0,0 1,0.342 0.091C4.439,2.749 6.444,5.269 6.65,5.625ZM12,6A6.006,6.006 0,0 0,6 0,0.5 0.5,0 0,0 6,1a5,5 0,1 1,-2.5 0.668A0.5,0.5 0,1 0,3 0.8,6 6,0 1,0 12,6Z",
  "M6.75,6a0.75,0.75 0,0 1,-1.5 0c0,-0.414 0.475,-3.581 0.5,-3.75S5.862,2 6,2s0.226,0.087 0.25,0.25S6.75,5.589 6.75,6ZM12,6a6,6 0,1 0,-6 6A6.006,6.006 0,0 0,12 6ZM11,6A5,5 0,1 1,6 1,5.006 5.006,0 0,1 11,6Z",
];

/** Frames in the strip (0 = empty, 12 = full). */
export const LAST_FRAME = TIMER_FRAMES.length - 1;

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

  return (
    <svg
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden
      className={cn("size-3 shrink-0", className)}
    >
      <path d={TIMER_FRAMES[frame]} />
    </svg>
  );
});
