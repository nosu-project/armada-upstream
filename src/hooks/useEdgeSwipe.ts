import { useCallback, useEffect, useRef, useState } from "react";

import { onAppStateChange } from "@/lib/appStateEvents";

/** Min horizontal travel (px) before we claim the gesture from the scroller. */
const CLAIM_THRESHOLD = 10;
/** Fraction of the pane width past which a release commits. */
const COMMIT_FRACTION = 0.25;
/** Flick velocity (px/ms) that commits regardless of distance. */
const COMMIT_VELOCITY = 0.3;
/**
 * Quiet time (no pointer traffic) after which an in-flight drag is declared
 * abandoned and springs back. Long enough that a finger deliberately holding
 * the pane mid-drag rarely hits it; short enough that a drag whose touch
 * stream the WebView cut without ANY terminating event self-heals in seconds
 * instead of pinning the pane until the app is killed.
 */
const STALL_RESET_MS = 3000;
/** How often the stale-drag watchdog checks. */
const STALL_POLL_MS = 500;

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
  /**
   * Streamed synchronously per pointermove with the live drag progress in px
   * toward the gesture's target (0..width) — NOT a React state update. The
   * caller maps it onto a transform with a direct style write, so tracking
   * the finger never re-renders the (heavy) page tree. Only `dragging`
   * (claim/release, twice per gesture) goes through state.
   */
  onDragMove?: (dragX: number) => void;
}

/**
 * True if the pointer starts inside an ancestor (up to `boundary`) that can
 * still scroll horizontally to the right. A rightward swipe there should scroll
 * that element (code blocks, tile rows), not reveal the list.
 */
function startsInRightwardScroller(
  target: EventTarget | null,
  boundary: HTMLElement,
): boolean {
  let el = target instanceof HTMLElement ? target : null;
  while (el && el !== boundary) {
    if (el.scrollWidth > el.clientWidth) {
      const style = getComputedStyle(el);
      const canScrollX = /(auto|scroll)/.test(style.overflowX);
      // Room to scroll further right → let the element consume the swipe.
      if (canScrollX && el.scrollLeft > 0) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Discord-style horizontal "swipe back/forward" gesture. Tracks a horizontal
 * drag and streams the live progress toward the target through `onDragMove`
 * (see its doc for why it is a callback, not state) for the caller to map
 * onto a `translateX`. On release it either commits (`onCommit`) or springs
 * back.
 *
 * - `direction: "open"` engages on a rightward drag starting anywhere on the
 *   chat pane (reveal the list). The `dx`-vs-`dy` claim test keeps it from
 *   fighting vertical scrolling, and a right-scrollable ancestor (code block,
 *   tile row) is left to consume the swipe instead. Message rows share this
 *   surface: swipe-to-reply (`useSwipeToReply`) is deliberately a LEFT swipe
 *   so the two gestures are disambiguated purely by direction.
 * - `direction: "close"` engages on a leftward drag from anywhere, used to
 *   bring a fully-revealed chat back over the list.
 */
export function useEdgeSwipe({
  enabled = true,
  direction = "open",
  onCommit,
  onDragMove,
}: UseEdgeSwipeOptions) {
  /** True while the finger is actively dragging (claimed). */
  const [dragging, setDragging] = useState(false);

  // Latest per-move callback, read through a ref so an inline closure from the
  // caller doesn't re-bind the pointer handlers every render.
  const onDragMoveRef = useRef(onDragMove);
  onDragMoveRef.current = onDragMove;

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
  // Mirror of the latest dragX kept in a ref so `finish` always sees the value
  // from the most recent pointermove, even if React hasn't re-rendered (and
  // re-bound `finish`) by the time `pointerup` fires on a quick flick.
  const dragXRef = useRef(0);

  // Sign that turns raw horizontal delta into "progress toward target":
  // opening tracks rightward (+dx), closing tracks leftward (−dx).
  const sign = direction === "open" ? 1 : -1;

  // Element the current gesture started on; carries the native (non-passive)
  // touchmove listener for the duration of the gesture.
  const touchTarget = useRef<HTMLElement | null>(null);

  // Once the drag is claimed, consume the native touch stream. React's own
  // touch/pointer listeners are passive, so preventDefault there can't stop the
  // browser from running its scroll gesture for the same touches — and a drag
  // the browser counts as a (touch-action-filtered) scroll arms its
  // tap-suppression window, which silently eats the click of any tap landing
  // within ~300ms after the swipe (the "first tap after swiping out does
  // nothing" bug). Cancelling touchmove keeps the gesture out of the scroll
  // pipeline entirely, so the following tap clicks normally.
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
    // React bails out when the value is unchanged, so calling this when
    // nothing is in flight (the `enabled` teardown below runs on every
    // disabled mount) is a true no-op rather than a wasted render.
    setDragging(false);
  }, [onNativeTouchMove]);

  // Abandon an in-flight gesture the moment the hook is disabled. `enabled` is
  // derived from the revealed/hidden state by the caller, so a NAVIGATION that
  // flips it lands here mid-drag. Without this the gesture is stranded in a
  // state nothing can leave: `onPointerDown` bails while disabled, and every
  // later move/up bails on the pointer-id mismatch — so `dragging` stays true
  // forever and pins the pane mid-slide.
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Clear an abandoned gesture BEFORE any bail. A drag whose pointerup
      // never arrived (the WebView's touch stream is cut when the app is
      // backgrounded — e.g. tapping a notification) otherwise survives with
      // its non-passive touchmove listener still attached, and a fresh touch
      // that bails below would leave it there permanently.
      if (claimed.current || pointerId.current !== null) reset();
      if (!enabled) return;
      if (e.pointerType === "mouse") return;
      const x = e.clientX;
      const el = e.currentTarget as HTMLElement;
      // A press inside a portaled overlay (the message action sheet, a dialog)
      // still lands here: React propagates synthetic events through the
      // COMPONENT tree, and the drawer is a React child of the pane even
      // though its DOM hangs off <body>. It is not a press on the pane —
      // letting it arm a drag slides the chat out from under the open menu.
      if (e.target instanceof Node && !el.contains(e.target)) {
        rejected.current = true;
        return;
      }
      // Opening can start anywhere on the pane; it's the drag length/direction
      // that reveals the list, not where it began. Bail only if the drag starts
      // inside something that can itself scroll right (code block, tile row).
      if (direction === "open" && startsInRightwardScroller(e.target, el)) {
        rejected.current = true;
        return;
      }
      widthRef.current = el.getBoundingClientRect().width || 1;
      startX.current = x;
      startY.current = e.clientY;
      lastX.current = x;
      lastT.current = e.timeStamp;
      velocity.current = 0;
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
        // Mostly-vertical (scroll) or wrong-direction move → not our gesture.
        // Require dy to *substantially* dominate dx (1.5x) so a thumb swiping
        // in a slight arc isn't permanently rejected at the first move — the
        // browser withholds early pointermove events under `touch-action:
        // pan-y` until it disambiguates, so the first event we see may already
        // have accumulated a bit of dy.
        if (Math.abs(dy) > Math.abs(dx) * 1.5 && Math.abs(dy) > CLAIM_THRESHOLD) {
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
      dragXRef.current = clamped;
      // Stream the position to the caller's direct style write; only the
      // claim itself renders (setDragging bails out once already true).
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
      const v = velocity.current;
      reset();
      if (!wasClaimed) return;
      const committed =
        dragged > widthRef.current * COMMIT_FRACTION || v > COMMIT_VELOCITY;
      if (committed) onCommit();
    },
    [onCommit, reset],
  );

  // Safety net for a gesture that never gets a terminating event on the
  // element itself. The element's own handlers are not enough: they are torn
  // off when the caller stops rendering them, they're skipped once the hook is
  // disabled, and the Android WebView can drop the tail of a touch stream
  // outright when the app is backgrounded (tapping a notification) without
  // ever dispatching pointercancel. Window-level `pointerup` is not a
  // duplicate of the element path — React's listeners live on the root
  // container, so `finish` has already run and nulled `pointerId` by the time
  // these see the event, making them a no-op on the normal path.
  useEffect(() => {
    if (!dragging) return;
    const onEnd = (e: PointerEvent) => {
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
    // The Android WebView also fails to deliver `visibilitychange`/`pagehide`
    // across some background transitions (the reason App.tsx drives
    // focusManager from Capacitor instead), so the reliable backgrounding
    // signal is Capacitor's `appStateChange`, raised from the activity
    // lifecycle rather than the renderer. Either flip abandons the drag: the
    // touch stream it belonged to is gone.
    const offAppState = onAppStateChange(() => reset());
    return () => {
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("pointerup", onEnd);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      offAppState();
    };
  }, [dragging, reset]);

  // Stale-drag watchdog, the net under the nets: every path above still needs
  // SOME event to be delivered, and the stuck-sliver reports show the WebView
  // can cut a touch stream with none at all. A claimed drag that has produced
  // no pointer traffic for STALL_RESET_MS cannot still be a live gesture, so
  // it springs back on a timer that depends on nothing but the event loop.
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
     * Live drag progress in px toward the gesture's target, 0..width, updated
     * synchronously per pointermove. A ref rather than state so a render that
     * happens mid-drag (for unrelated reasons) can still paint the current
     * position without the gesture itself ever forcing one.
     */
    dragXRef,
    /**
     * Abandon any in-flight drag and spring back. Exposed so the caller can
     * make a programmatic state change (navigation) win over a stale gesture.
     * Stable across renders.
     */
    cancel: reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
  };
}
