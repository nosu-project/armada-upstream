import { useCallback, useEffect, useRef, useState } from "react";

/** How long a press rests before it becomes a drag, on every pointer type. */
const PICKUP_MS = 300;
/** Past this, a touch that started on a row is a scroll and never a drag. */
const SCROLL_SLOP_PX = 8;

/** A place a channel can be dropped: an insertion point in the rendered list. */
export interface ChannelDropSlot {
  /** Index in the rendered order, i.e. how many channels precede this point. */
  index: number;
  /** The heading this point falls under; undefined is the uncategorized run. */
  category: string | undefined;
  /** Viewport y of the insertion line. */
  y: number;
  /** True for the trailing "new category" zone. */
  newCategory?: boolean;
}

export interface ChannelDrop {
  index: number;
  category: string | undefined;
  newCategory?: boolean;
}

export interface ChannelDragState {
  /** The channel being dragged, or null. */
  sourceIdHex: string | null;
  /** Where it would land — drives the indicator and the heading highlight. */
  target: ChannelDrop | null;
  /** Viewport y of the drop indicator. */
  indicatorY: number | null;
}

/**
 * Press-and-hold drag for the channel sidebar.
 *
 * Modelled on the server rail's drag (`ServerRail.tsx`), and it repeats that
 * one's hard-won parts rather than sharing them: the rail's is entangled with
 * folder combining, mini-grid ghosts and its own layout algebra, and prying
 * those apart is a bigger, riskier change than this feature warrants. What is
 * shared is the LESSONS, noted where they bite.
 *
 * Two of them matter enough to state up front:
 *
 * - Rows must carry `touch-action: none`. It is the only reliable way to stop
 *   Chrome claiming the gesture as a pan and killing the drag with
 *   `pointercancel`; its arbitration is racy no matter what is
 *   `preventDefault`ed. The cost is that the browser then never scrolls the
 *   list for a gesture that starts on a row, so a touch that turns out to be a
 *   scroll is panned here by hand.
 *
 * - Radix's `ContextMenuTrigger` opens on its own ~700ms touch long-press, and
 *   these rows have one. Pickup at 300ms would otherwise be followed by the
 *   menu opening on top of the drag. Radix clears that timer on
 *   `pointercancel`, so beginning a drag dispatches one at the source — which
 *   is also just true: the press stopped being a press.
 */
export function useChannelDrag({
  enabled,
  scrollRef,
  measure,
  onDrop,
}: {
  /** False for a member who can't rearrange: no timers, no listeners. */
  enabled: boolean;
  /** The scrolling channel column, panned by hand during a touch drag. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Measures the current drop slots. Called once per drag, at pickup. */
  measure: () => ChannelDropSlot[];
  onDrop: (sourceIdHex: string, drop: ChannelDrop) => void;
}) {
  const [state, setState] = useState<ChannelDragState>({
    sourceIdHex: null,
    target: null,
    indicatorY: null,
  });
  const active = useRef<string | null>(null);
  const slots = useRef<ChannelDropSlot[]>([]);
  const targetRef = useRef<ChannelDrop | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the panning finger was last seen, for the manual scroll delta. */
  const panAnchor = useRef(0);

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    active.current = null;
    targetRef.current = null;
    slots.current = [];
    setState({ sourceIdHex: null, target: null, indicatorY: null });
  }, []);

  useEffect(() => reset, [reset]);

  const aim = useCallback((y: number) => {
    let best: ChannelDropSlot | null = null;
    let bestDistance = Infinity;
    for (const slot of slots.current) {
      const distance = Math.abs(slot.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slot;
      }
    }
    if (!best) return;
    targetRef.current = { index: best.index, category: best.category, newCategory: best.newCategory };
    setState({ sourceIdHex: active.current, target: targetRef.current, indicatorY: best.y });
  }, []);

  const onPointerDown = useCallback(
    (idHex: string) => (e: React.PointerEvent) => {
      if (!enabled || e.button !== 0) return;
      const source = e.currentTarget as HTMLElement;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      // Latest position, so a pickup that fires after the finger wandered aims
      // where the finger IS rather than where it landed.
      let lastY = startY;
      let scrolling = false;

      const clear = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("contextmenu", onContextMenu, true);
      };

      // Swallow the platform's own long-press callout while a drag is in
      // flight — it would otherwise pop over the gesture.
      const onContextMenu = (ev: Event) => {
        if (active.current !== null) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        lastY = ev.clientY;
        if (active.current !== null) {
          if (ev.cancelable) ev.preventDefault();
          aim(ev.clientY);
          return;
        }
        const dx = Math.abs(ev.clientX - startX);
        const dy = Math.abs(ev.clientY - startY);
        // Rows are `touch-action: none`, so the browser will not scroll this
        // column for us; a gesture that committed to scrolling gets panned by
        // hand from here until it ends.
        if (scrolling || (ev.pointerType === "touch" && dy > SCROLL_SLOP_PX && dy > dx)) {
          scrolling = true;
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
          scrollRef.current?.scrollBy({ top: -(ev.clientY - panAnchor.current) });
          panAnchor.current = ev.clientY;
          return;
        }
        if (dx > SCROLL_SLOP_PX || dy > SCROLL_SLOP_PX) clear();
      };

      const onUp = () => {
        const drop = targetRef.current;
        const dragged = active.current;
        clear();
        if (dragged && drop) onDrop(dragged, drop);
        reset();
      };

      const onCancel = () => {
        clear();
        reset();
      };

      panAnchor.current = startY;
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("contextmenu", onContextMenu, true);

      timer.current = setTimeout(() => {
        timer.current = null;
        if (scrolling) return;
        active.current = idHex;
        slots.current = measure();
        // The press has stopped being a press: tell Radix's context menu so it
        // doesn't open its own long-press menu over the drag.
        source.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId }));
        aim(lastY);
      }, PICKUP_MS);
    },
    [enabled, measure, onDrop, aim, reset, scrollRef],
  );

  return { ...state, onPointerDown, dragging: state.sourceIdHex !== null };
}
