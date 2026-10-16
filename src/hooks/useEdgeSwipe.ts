import { useCallback, useEffect, useRef, useState } from "react";

import { isHandScrolling } from "@/hooks/usePressDrag";
import { cancelPressUnder, isCancellingPress } from "@/lib/cancelPress";
import { onAppStateChange } from "@/lib/appStateEvents";

/** Min horizontal travel (px) before we claim the gesture from the scroller. */
const CLAIM_THRESHOLD = 10;
const COMMIT_FRACTION = 0.25;
/** Flick velocity (px/ms) that commits regardless of distance; flicking back this fast cancels. */
const COMMIT_VELOCITY = 0.3;
/** Release velocity is measured over this trailing window: a thumb slows in its last sample. */
const VELOCITY_WINDOW_MS = 100;
/** A finger that rested this long before lifting released at zero velocity. */
const VELOCITY_REST_MS = 50;
/**
 * No pointer traffic for this long abandons a drag, so a touch stream the WebView cut
 * without any terminating event self-heals.
 */
const STALL_RESET_MS = 3000;
const STALL_POLL_MS = 500;

export interface UseEdgeSwipeOptions {
  enabled?: boolean;
  /** "open": rightward drag (reveal the list). "close": leftward drag from anywhere. */
  direction?: "open" | "close";
  onCommit: () => void;
  /**
   * Called on every claimed release, before `onCommit`, with the release velocity
   * (px/ms, positive toward committing) and whether it committed.
   */
  onRelease?: (velocity: number, committed: boolean) => void;
  /**
   * Called synchronously per pointermove with progress in px (0..width), NOT state, so
   * tracking the finger never re-renders the page tree.
   */
  onDragMove?: (dragX: number) => void;
}

/** A rightward swipe inside a right-scrollable ancestor (code blocks, tile rows) scrolls it. */
function startsInRightwardScroller(
  target: EventTarget | null,
  boundary: HTMLElement,
): boolean {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el !== boundary) {
    if (el.scrollWidth > el.clientWidth) {
      const style = getComputedStyle(el);
      const canScrollX = /(auto|scroll)/.test(style.overflowX);
      if (canScrollX && el.scrollLeft > 0) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Discord-style horizontal swipe gesture; commits (`onCommit`) or springs back.
 * Swipe-to-reply (`useSwipeToReply`) is a LEFT swipe so the two are disambiguated by direction.
 */
export function useEdgeSwipe({
  enabled = true,
  direction = "open",
  onCommit,
  onRelease,
  onDragMove,
}: UseEdgeSwipeOptions) {
  const [dragging, setDragging] = useState(false);

  // Ref so an inline caller closure doesn't re-bind the pointer handlers.
  const onDragMoveRef = useRef(onDragMove);
  onDragMoveRef.current = onDragMove;
  const onReleaseRef = useRef(onRelease);
  onReleaseRef.current = onRelease;

  // Kept off React state to avoid re-renders mid-drag.
  const startX = useRef(0);
  const startY = useRef(0);
  const lastT = useRef(0);
  /** Recent progress-space positions, for the release velocity. */
  const samples = useRef<{ t: number; x: number }[]>([]);
  const widthRef = useRef(1);
  const claimed = useRef(false);
  const rejected = useRef(false);
  const pointerId = useRef<number | null>(null);
  // Ref so `finish` sees the latest move even before React re-renders on a quick flick.
  const dragXRef = useRef(0);

  const sign = direction === "open" ? 1 : -1;

  // Carries the native (non-passive) touchmove listener for the gesture's duration.
  const touchTarget = useRef<HTMLElement | null>(null);

  // React's touch listeners are passive, so the browser would count the drag as a scroll and
  // arm its tap-suppression window, eating the next tap (~300ms). Cancel native touchmove.
  const onNativeTouchMove = useCallback((e: TouchEvent) => {
    if (claimed.current && e.cancelable) e.preventDefault();
  }, []);

  const reset = useCallback(() => {
    claimed.current = false;
    rejected.current = false;
    pointerId.current = null;
    dragXRef.current = 0;
    touchTarget.current?.removeEventListener("touchmove", onNativeTouchMove);
    touchTarget.current = null;
    // React bails on an unchanged value, so this is a no-op when nothing is in flight.
    setDragging(false);
  }, [onNativeTouchMove]);

  // Abandon an in-flight gesture when disabled (e.g. by navigation), or `dragging` gets stuck true.
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Clear an abandoned gesture BEFORE any bail: a backgrounded WebView can cut the touch
      // stream and leave its touchmove listener attached.
      if (claimed.current || pointerId.current !== null) reset();
      if (!enabled) return;
      if (e.pointerType === "mouse") return;
      const x = e.clientX;
      const el = e.currentTarget as HTMLElement;
      // Presses in portaled overlays propagate through the React tree; they're not presses on the pane.
      if (e.target instanceof Node && !el.contains(e.target)) {
        rejected.current = true;
        return;
      }
      // Bail only if the drag starts inside something that can itself scroll right.
      if (direction === "open" && startsInRightwardScroller(e.target, el)) {
        rejected.current = true;
        return;
      }
      widthRef.current = el.getBoundingClientRect().width || 1;
      startX.current = x;
      startY.current = e.clientY;
      lastT.current = e.timeStamp;
      samples.current = [{ t: e.timeStamp, x: 0 }];
      claimed.current = false;
      rejected.current = false;
      pointerId.current = e.pointerId;
      touchTarget.current?.removeEventListener("touchmove", onNativeTouchMove);
      touchTarget.current = el;
      el.addEventListener("touchmove", onNativeTouchMove, { passive: false });
    },
    [enabled, direction, onNativeTouchMove, reset],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (pointerId.current !== e.pointerId || rejected.current) return;

      const dx = (e.clientX - startX.current) * sign; // progress-space delta
      const dy = e.clientY - startY.current;

      if (!claimed.current) {
        if (isHandScrolling(e.pointerId)) {
          rejected.current = true;
          return;
        }
        // Require dy to dominate by 1.5x: under `touch-action: pan-y` the first event we see may
        // already carry some dy from a slight arc.
        if (Math.abs(dy) > Math.abs(dx) * 1.5 && Math.abs(dy) > CLAIM_THRESHOLD) {
          rejected.current = true;
          return;
        }
        if (dx > CLAIM_THRESHOLD) {
          claimed.current = true;
          // Capture starves the press target of its move/up; stand its long-press down.
          cancelPressUnder(e.target, e.currentTarget as HTMLElement, e.pointerId, e.pointerType);
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } else {
          return;
        }
      }

      if (e.cancelable) e.preventDefault();

      const now = e.timeStamp;
      lastT.current = now;
      const recent = samples.current;
      recent.push({ t: now, x: dx });
      while (recent.length > 2 && now - recent[0].t > VELOCITY_WINDOW_MS) recent.shift();

      const clamped = Math.max(0, Math.min(dx, widthRef.current));
      dragXRef.current = clamped;
      onDragMoveRef.current?.(clamped);
      setDragging(true);
    },
    [sign],
  );

  const finish = useCallback(
    (e: React.PointerEvent) => {
      if (pointerId.current !== e.pointerId) return;
      const wasClaimed = claimed.current;
      const dragged = dragXRef.current;
      const recent = samples.current;
      const first = recent[0];
      const last = recent[recent.length - 1];
      const v =
        first && last && last.t > first.t && e.timeStamp - last.t <= VELOCITY_REST_MS
          ? (last.x - first.x) / (last.t - first.t)
          : 0;
      reset();
      if (!wasClaimed) return;
      const committed =
        (dragged > widthRef.current * COMMIT_FRACTION && v > -COMMIT_VELOCITY) || v > COMMIT_VELOCITY;
      onReleaseRef.current?.(v, committed);
      if (committed) onCommit();
    },
    [onCommit, reset],
  );

  // A cancel means someone else took the touch — on Android, the system back gesture
  // pilfers it from the WebView mid-swipe, then delivers back on its own. Never commit.
  const abandon = useCallback(
    (e: React.PointerEvent) => {
      if (isCancellingPress()) return;
      if (pointerId.current === e.pointerId) reset();
    },
    [reset],
  );

  // Safety net for gestures with no terminating element event (handlers torn off, hook
  // disabled, or Android WebView dropping the stream on background). Window `pointerup` is a
  // no-op on the normal path since `finish` already nulled `pointerId`.
  useEffect(() => {
    if (!dragging) return;
    const onEnd = (e: PointerEvent) => {
      if (isCancellingPress()) return;
      if (pointerId.current === null || pointerId.current === e.pointerId) reset();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") reset();
    };
    const onPageHide = () => reset();
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("pointerup", onEnd);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    // Android WebView may not deliver `visibilitychange` on background; Capacitor's
    // `appStateChange` is the reliable signal.
    const offAppState = onAppStateChange(() => reset());
    return () => {
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("pointerup", onEnd);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      offAppState();
    };
  }, [dragging, reset]);

  // Watchdog: the WebView can cut a touch stream with no event at all.
  useEffect(() => {
    if (!dragging) return;
    const id = window.setInterval(() => {
      if (performance.now() - lastT.current > STALL_RESET_MS) reset();
    }, STALL_POLL_MS);
    return () => window.clearInterval(id);
  }, [dragging, reset]);

  return {
    dragging,
    /**
     * Live progress in px (0..width); a ref so unrelated mid-drag renders paint the current
     * position.
     */
    dragXRef,
    /** Abandon any in-flight drag so a programmatic navigation wins. Stable. */
    cancel: reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: abandon,
    },
  };
}
