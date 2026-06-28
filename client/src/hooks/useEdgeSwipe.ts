import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How far from the left edge (px) an OPEN drag may start. This is wide on
 * purpose: on Android the OS reserves the very edge for its own gesture nav, so
 * a swipe that starts a little *inside* the chat (past the OS strip) still needs
 * to reveal the list. A clearly-horizontal rightward move is required to claim
 * it (see {@link CLAIM_THRESHOLD} / the dx-vs-dy test), so the wide zone doesn't
 * fight vertical scrolling.
 */
const EDGE_ZONE = 64;
/** Min horizontal travel (px) before we claim the gesture from the scroller. */
const CLAIM_THRESHOLD = 10;
/** Fraction of the pane width past which a release commits. */
const COMMIT_FRACTION = 0.4;
/** Flick velocity (px/ms) that commits regardless of distance. */
const COMMIT_VELOCITY = 0.4;

export interface EdgeSwipeState {
  /**
   * Live drag progress in px toward the gesture's target, 0..width.
   * For an "open" gesture this is how far the chat has slid right; for a
   * "close" gesture it's how far it has slid back left from fully-open.
   */
  dragX: number;
  /** True while the finger is actively dragging. */
  dragging: boolean;
}

export interface UseEdgeSwipeOptions {
  /** Disable the gesture entirely (e.g. on desktop / non-touch). */
  enabled?: boolean;
  /**
   * "open": rightward drag starting near the left edge (reveal the list).
   * "close": leftward drag from anywhere (slide the chat back over the list).
   */
  direction?: "open" | "close";
  /** Called when a drag crosses the commit threshold and is released. */
  onCommit: () => void;
}

/**
 * Discord-style horizontal "swipe back/forward" gesture. Tracks a horizontal
 * drag and reports a live `dragX` (progress toward the target) the caller maps
 * onto a `translateX`. On release it either commits (`onCommit`) or springs
 * back.
 *
 * - `direction: "open"` engages only when the touch starts within
 *   {@link EDGE_ZONE}px of the left edge and the finger moves right — so it
 *   never fights vertical scrolling or in-message horizontal gestures.
 * - `direction: "close"` engages on a leftward drag from anywhere, used to
 *   bring a fully-revealed chat back over the list.
 */
export function useEdgeSwipe({
  enabled = true,
  direction = "open",
  onCommit,
}: UseEdgeSwipeOptions) {
  const [state, setState] = useState<EdgeSwipeState>({ dragX: 0, dragging: false });

  // Mutable gesture bookkeeping kept off React state to avoid re-renders mid-drag.
  const startX = useRef(0);
  const startY = useRef(0);
  const lastX = useRef(0);
  const lastT = useRef(0);
  const velocity = useRef(0); // signed px/ms in the *progress* direction
  const widthRef = useRef(1);
  const claimed = useRef(false);
  const rejected = useRef(false);
  const pointerId = useRef<number | null>(null);

  // Sign that turns raw horizontal delta into "progress toward target":
  // opening tracks rightward (+dx), closing tracks leftward (−dx).
  const sign = direction === "open" ? 1 : -1;

  const reset = useCallback(() => {
    claimed.current = false;
    rejected.current = false;
    pointerId.current = null;
    setState({ dragX: 0, dragging: false });
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (e.pointerType === "mouse") return;
      const x = e.clientX;
      // Opening must start near the left edge; closing can start anywhere.
      if (direction === "open" && x > EDGE_ZONE) {
        rejected.current = true;
        return;
      }
      const el = e.currentTarget as HTMLElement;
      widthRef.current = el.getBoundingClientRect().width || 1;
      startX.current = x;
      startY.current = e.clientY;
      lastX.current = x;
      lastT.current = e.timeStamp;
      velocity.current = 0;
      claimed.current = false;
      rejected.current = false;
      pointerId.current = e.pointerId;
    },
    [enabled, direction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (pointerId.current !== e.pointerId || rejected.current) return;

      const dx = (e.clientX - startX.current) * sign; // progress-space delta
      const dy = e.clientY - startY.current;

      if (!claimed.current) {
        // Mostly-vertical (scroll) or wrong-direction move → not our gesture.
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > CLAIM_THRESHOLD) {
          rejected.current = true;
          return;
        }
        if (dx > CLAIM_THRESHOLD) {
          claimed.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } else {
          return;
        }
      }

      if (e.cancelable) e.preventDefault();

      const now = e.timeStamp;
      const dt = now - lastT.current;
      if (dt > 0) velocity.current = ((e.clientX - lastX.current) * sign) / dt;
      lastX.current = e.clientX;
      lastT.current = now;

      const clamped = Math.max(0, Math.min(dx, widthRef.current));
      setState({ dragX: clamped, dragging: true });
    },
    [sign],
  );

  const finish = useCallback(
    (e: React.PointerEvent) => {
      if (pointerId.current !== e.pointerId) return;
      const wasClaimed = claimed.current;
      const dragged = state.dragX;
      const v = velocity.current;
      reset();
      if (!wasClaimed) return;
      const committed =
        dragged > widthRef.current * COMMIT_FRACTION || v > COMMIT_VELOCITY;
      if (committed) onCommit();
    },
    [onCommit, reset, state.dragX],
  );

  // Safety net: if the gesture is interrupted (pointercancel) clean up.
  useEffect(() => {
    if (!state.dragging) return;
    const onCancel = () => reset();
    window.addEventListener("pointercancel", onCancel);
    return () => window.removeEventListener("pointercancel", onCancel);
  }, [state.dragging, reset]);

  return {
    ...state,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}
