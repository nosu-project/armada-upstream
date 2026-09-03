import { useCallback, useEffect, useRef, useState } from "react";

import { impact } from "@/lib/haptics";

/** How long a press rests before it becomes a drag, on every pointer type. */
const PICKUP_MS = 300;
/** Past this much movement, a touch that started on an entry is a scroll. */
const SCROLL_SLOP_PX = 10;
/**
 * Travel from the press origin (at ANY point in the gesture — the pointer can
 * wander during the hold before pickup) past which a press-and-hold is a real
 * drag. A pickup that never leaves this radius is a tap the user simply held a
 * beat too long: it must NOT apply a (no-op) drop or suppress the navigation
 * click — the reported "held the community icon and nothing opened" lost tap.
 * Matched to the scroll slop so a touch wobble that would set it has already
 * become a scroll (and never picked up).
 */
const DRAG_MOVE_SLOP_PX = 10;
/**
 * While a drag is in flight, a pointer this close to the container's top or
 * bottom edge scrolls it toward that edge, so a list taller than the viewport
 * is reachable without letting go. Zero at the boundary, ramping to
 * {@link EDGE_SCROLL_MAX_PX} per frame at the very edge.
 */
const EDGE_SCROLL_ZONE_PX = 56;
/** Fastest the edge auto-scroll pans, per animation frame. */
const EDGE_SCROLL_MAX_PX = 14;
/** Slowest it pans while still inside the zone, so it never stalls sub-pixel. */
const EDGE_SCROLL_MIN_PX = 2;

export interface PressDragOptions<T> {
  /**
   * The scrolling container the draggables live in. Owned by the caller (which
   * measures its geometry at pickup) and populated by `attachContainer`.
   */
  containerRef: React.MutableRefObject<HTMLElement | null>;
  /**
   * Freeze the drop geometry and start previewing. Called once, at pickup,
   * off a DOM that has not yet moved — the rendered order must not change
   * during a drag, so measuring here is measuring for the whole gesture.
   */
  onPickup: (source: T, x: number, y: number) => void;
  /** Re-aim at the pointer. Called for every move once picked up. */
  onAim: (source: T, x: number, y: number) => void;
  /** Apply the drop. */
  onDrop: (source: T) => void;
  /** The browser reclaimed the pointer: abort WITHOUT applying. */
  onAbort: () => void;
  /**
   * The container was auto-scrolled under a stationary pointer during a drag.
   * Called before the ensuing re-aim, so a caller that froze slot geometry at
   * pickup can re-measure it against the new scroll offset. Optional: a caller
   * whose geometry doesn't move with the container needs nothing here.
   */
  onContainerScroll?: () => void;
}

/**
 * Press-and-hold drag, shared by the server rail and the channel sidebar.
 *
 * The gesture only: a press rests for {@link PICKUP_MS} on any pointer type,
 * then the pointer aims until release. What a slot IS, how a drop is planned
 * and what it changes are all the caller's — this hook knows a pointer and an
 * opaque source.
 *
 * Three parts of it are not obvious and were paid for in bugs:
 *
 * - **The touchmove canceller is permanent, and lives on the container.**
 *   Chrome decides at *touchstart* whether a blocking touch listener covers
 *   the region; one attached mid-gesture (in `pointerdown`, say) is never
 *   consulted, its `preventDefault` is silently ignored, and the browser pans
 *   the container anyway — killing the drag with `pointercancel` on the first
 *   move. So it is attached to the container as it mounts, and cancels only
 *   while a drag is live, leaving ordinary scrolling native. Touch events keep
 *   targeting the touchstart element, so a drag that wanders outside the
 *   container still bubbles through it.
 *
 * - **Entries must also carry `touch-action: none`,** unconditionally rather
 *   than behind a `touch:` variant. The canceller above and this are belt and
 *   braces against the same racy gesture arbitration, and the cost is that the
 *   browser never scrolls the container for a gesture that starts on an entry
 *   — so a touch that turns out to be a scroll is panned here by hand.
 *
 * - **Attach `begin` natively, via {@link useDragPointerDown}.** Radix
 *   `asChild` Slots do not reliably forward React pointer props, and several
 *   entries on both surfaces are Slots.
 *
 * Mouse movement during the hold neither picks up nor cancels: the press still
 * completes, at the cursor's current position. Early touch movement converts
 * the gesture to a scroll instead, and no drag follows.
 */
export function usePressDrag<T>({
  containerRef,
  onPickup,
  onAim,
  onDrop,
  onAbort,
  onContainerScroll,
}: PressDragOptions<T>) {
  const [source, setSource] = useState<T | null>(null);
  /** The in-flight drag, read inside listeners where state would be stale. */
  const active = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set briefly after a drag so the ensuing click doesn't navigate/toggle. */
  const didDrag = useRef(false);
  // Held by ref so the listeners never close over a stale callback and `begin`
  // stays referentially stable across renders.
  const handlers = useRef({ onPickup, onAim, onDrop, onAbort, onContainerScroll });
  handlers.current = { onPickup, onAim, onDrop, onAbort, onContainerScroll };

  const onTouchMove = useCallback((ev: TouchEvent) => {
    if (active.current !== null && ev.cancelable) ev.preventDefault();
  }, []);

  /**
   * Ref to put on the scrolling container. A callback ref rather than an
   * effect on a `RefObject`: the container may well mount after the hook
   * (behind a loading gate), and an effect that read a still-null ref would
   * leave the canceller off — the failure it exists to prevent, arriving
   * silently.
   */
  const attachContainer = useCallback(
    (el: HTMLElement | null) => {
      containerRef.current?.removeEventListener("touchmove", onTouchMove);
      containerRef.current = el;
      el?.addEventListener("touchmove", onTouchMove, { passive: false });
    },
    [containerRef, onTouchMove],
  );

  // While an entry is picked up, carry the grabbing cursor globally. At rest
  // entries show the normal cursor — a grab-on-hover hand suggested a drag
  // affordance before anything was picked up, which confused people.
  const dragging = source !== null;
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragging]);

  const begin = useCallback(
    (from: T) => (e: PointerEvent) => {
      // Only left mouse / touch / pen; ignore right-click etc.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const pointerId = e.pointerId;
      const isMouse = e.pointerType === "mouse";
      const startX = e.clientX;
      const startY = e.clientY;
      // Latest position, so a press that completes after the pointer wandered
      // picks up at the cursor rather than at the press point.
      let lastX = startX;
      let lastY = startY;
      // Set once the gesture is classified as a scroll rather than a drag.
      let manualScroll = false;
      let lastScrollY = startY;
      // Whether the pointer ever travelled past the drag slop from the press
      // origin (measured across the WHOLE gesture, before pickup included — a
      // mouse can drag to the target during the hold). A pickup that never did
      // is a long-held tap that must still navigate, not a (no-op) reorder.
      let everMovedFar = false;
      // The rAF handle for the edge auto-scroll loop below, live only between
      // pickup and release.
      let autoScrollRaf: number | null = null;

      const stopAutoScroll = () => {
        if (autoScrollRaf !== null) cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
      };

      // While a live drag holds the pointer near the container's top or bottom
      // edge, pan toward it and re-aim — no pointer event fires while the
      // finger is still, so this runs on its own frame loop rather than in
      // onMove. The slot geometry was frozen at pickup in viewport
      // coordinates, so scrolling moves the rows out from under it;
      // onContainerScroll lets the caller re-measure before the re-aim.
      const autoScrollTick = () => {
        autoScrollRaf = requestAnimationFrame(autoScrollTick);
        if (active.current === null) return;
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // Never let the two zones overlap on a short container.
        const zone = Math.min(EDGE_SCROLL_ZONE_PX, rect.height / 2);
        const fromTop = lastY - rect.top;
        const fromBottom = rect.bottom - lastY;
        let delta = 0;
        if (fromTop < zone && el.scrollTop > 0) {
          const ramp = (zone - Math.max(0, fromTop)) / zone;
          delta = -Math.max(EDGE_SCROLL_MIN_PX, ramp * EDGE_SCROLL_MAX_PX);
        } else if (fromBottom < zone && el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
          const ramp = (zone - Math.max(0, fromBottom)) / zone;
          delta = Math.max(EDGE_SCROLL_MIN_PX, ramp * EDGE_SCROLL_MAX_PX);
        }
        if (delta === 0) return;
        const before = el.scrollTop;
        el.scrollTop = before + delta;
        if (el.scrollTop === before) return;
        handlers.current.onContainerScroll?.();
        handlers.current.onAim(active.current, lastX, lastY);
      };

      const clear = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        stopAutoScroll();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("contextmenu", onContextMenu, true);
      };

      // While a drag is in flight, swallow the context menu the browser
      // synthesizes for a touch long-press — it would otherwise pop an
      // entry's Radix menu in the middle of the gesture.
      const onContextMenu = (ev: Event) => {
        if (active.current !== null) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!everMovedFar && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_MOVE_SLOP_PX) {
          everMovedFar = true;
        }
        if (active.current === null) {
          lastX = ev.clientX;
          lastY = ev.clientY;
          // Entries are `touch-action: none`, so the browser never scrolls the
          // container for a gesture that starts on one; pan it here instead.
          if (manualScroll) {
            const el = containerRef.current;
            if (el) el.scrollTop -= ev.clientY - lastScrollY;
            lastScrollY = ev.clientY;
            return;
          }
          if (isMouse) return;
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > SCROLL_SLOP_PX) {
            // Touch movement before the press completes is a scroll — hand the
            // rest of the gesture to the manual panner above.
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            manualScroll = true;
            lastScrollY = ev.clientY;
          }
          return;
        }
        if (ev.cancelable) ev.preventDefault();
        // Keep the latest pointer position for the edge auto-scroll loop,
        // which re-aims from it while the finger is otherwise still.
        lastX = ev.clientX;
        lastY = ev.clientY;
        handlers.current.onAim(active.current, ev.clientX, ev.clientY);
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dragged = active.current;
        active.current = null;
        clear();
        setSource(null);
        if (dragged === null) return;
        // A pickup that never travelled past the slop is a long-held TAP, not a
        // reorder: abort the no-op drop and leave the click un-suppressed so
        // navigation still fires. Otherwise holding an entry past PICKUP_MS
        // swallows the tap (the reported "held the icon, nothing opened").
        if (!everMovedFar) {
          handlers.current.onAbort();
          return;
        }
        try {
          handlers.current.onDrop(dragged);
        } catch (err) {
          // Never let a failed drop wedge the drag state or leave listeners
          // attached (this bit us when crypto.randomUUID threw over http).
          console.error("Failed to apply drop:", err);
        }
        didDrag.current = true;
        // Keep the guard up long enough to swallow the click the browser
        // synthesizes after pointerup, then clear it.
        setTimeout(() => {
          didDrag.current = false;
        }, 300);
      };

      // The browser reclaimed the pointer (scroll takeover, palm rejection,
      // system gesture): abort WITHOUT applying — the last plan no longer
      // reflects the user's intent.
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        active.current = null;
        clear();
        setSource(null);
        handlers.current.onAbort();
      };

      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("contextmenu", onContextMenu, true);

      // Press-and-hold pickup — the ONLY trigger, on every pointer type.
      // Guarded: a touch gesture that converted to a scroll cleared the timer.
      timer.current = setTimeout(() => {
        timer.current = null;
        if (active.current !== null) return;
        active.current = from;
        handlers.current.onPickup(from, lastX, lastY);
        setSource(from);
        impact("medium");
        // Run the edge auto-scroll loop for the life of the drag, so the
        // pointer resting near an edge keeps scrolling with no further move.
        autoScrollTick();
      }, PICKUP_MS);
    },
    [containerRef],
  );

  /** Returns true if a click should be suppressed (a drag just finished). */
  const shouldSuppressClick = useCallback(() => didDrag.current, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { attachContainer, begin, source, dragging, shouldSuppressClick };
}

/**
 * Attach {@link usePressDrag}'s `begin` as a NATIVE pointerdown listener.
 * Radix `asChild` Slots do not reliably forward React pointer props, and both
 * surfaces put draggables inside Slots.
 */
export function useDragPointerDown(
  ref: React.RefObject<HTMLElement | null>,
  draggable: boolean | undefined,
  onDragPointerDown: ((e: PointerEvent) => void) | undefined,
) {
  const handlerRef = useRef(onDragPointerDown);
  handlerRef.current = onDragPointerDown;
  useEffect(() => {
    const el = ref.current;
    if (!el || !draggable) return;
    const handler = (e: PointerEvent) => handlerRef.current?.(e);
    el.addEventListener("pointerdown", handler);
    return () => el.removeEventListener("pointerdown", handler);
  }, [ref, draggable]);
}
