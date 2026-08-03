import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { usePressDrag } from "@/hooks/usePressDrag";

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

/**
 * Press-and-hold drag for the channel sidebar.
 *
 * The gesture is {@link usePressDrag}, the same one the server rail runs on —
 * including the parts that are not guessable (the permanent touchmove
 * canceller, `touch-action: none` on rows, hand-panning a touch that turns out
 * to be a scroll). This hook is only the channel-shaped half: what a slot is,
 * which one the pointer is nearest, and what the indicator draws.
 *
 * Rows must carry `touch-none` while the drag is enabled — unconditionally,
 * not behind the `touch:` variant.
 */
export function useChannelDrag({
  enabled,
  columnRef,
  measure,
  onDrop,
}: {
  /** False for a member who can't rearrange: no timers, no listeners. */
  enabled: boolean;
  /**
   * The scrolling channel column, populated by `attachColumn`. The caller owns
   * it because the caller is what measures the slots inside it.
   */
  columnRef: React.MutableRefObject<HTMLElement | null>;
  /** Measures the current drop slots. Called once per drag, at pickup. */
  measure: () => ChannelDropSlot[];
  onDrop: (sourceIdHex: string, drop: ChannelDrop) => void;
}) {
  /** Where it would land — drives the indicator and the heading highlight. */
  const [target, setTarget] = useState<ChannelDrop | null>(null);
  /** Viewport y of the drop indicator. */
  const [indicatorY, setIndicatorY] = useState<number | null>(null);
  /** Viewport x/width of the column, so the indicator spans only it. */
  const [columnX, setColumnX] = useState<{ left: number; width: number } | null>(null);
  /** Viewport position of the pointer, which the floating ghost follows. */
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  const slots = useRef<ChannelDropSlot[]>([]);
  const targetRef = useRef<ChannelDrop | null>(null);
  /** Last aimed-at point, so a re-measure can re-aim without a pointer event. */
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  // Held by ref: the re-measure below must not re-run when the caller happens
  // to hand us a new closure.
  const measureRef = useRef(measure);
  measureRef.current = measure;

  const aim = useCallback((_source: string, x: number, y: number) => {
    lastPoint.current = { x, y };
    setPointer({ x, y });
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
    setTarget(targetRef.current);
    setIndicatorY(best.y);
  }, []);

  const finish = useCallback(() => {
    const landed = targetRef.current;
    targetRef.current = null;
    slots.current = [];
    setTarget(null);
    setIndicatorY(null);
    setColumnX(null);
    setPointer(null);
    return landed;
  }, []);

  const drag = usePressDrag<string>({
    containerRef: columnRef,
    onPickup: (idHex, x, y) => {
      slots.current = measure();
      const rect = columnRef.current?.getBoundingClientRect();
      setColumnX(rect ? { left: rect.left, width: rect.width } : null);
      aim(idHex, x, y);
    },
    onAim: aim,
    onDrop: (idHex) => {
      const landed = finish();
      if (landed) onDrop(idHex, landed);
    },
    onAbort: finish,
  });

  /**
   * Re-measure once the drag chrome has mounted.
   *
   * The trailing "new category" zone exists only WHILE a drag is in flight, so
   * it cannot be among the slots measured at pickup — it was not in the DOM
   * yet, and aiming at it was therefore impossible. Nothing else moves at
   * pickup (the source row goes `invisible`, keeping its box, and the
   * placeholder over it is absolute), so this adds the zone rather than
   * shifting anything already measured.
   */
  useLayoutEffect(() => {
    if (!drag.dragging) return;
    slots.current = measureRef.current();
    const at = lastPoint.current;
    if (at) aim("", at.x, at.y);
  }, [drag.dragging, aim]);

  const onPointerDown = useCallback(
    (idHex: string) => (e: React.PointerEvent) => {
      // A plain wrapper div, not a Radix `asChild` Slot, so React's own
      // pointer prop is delivered — the rail's native-listener workaround
      // isn't needed here.
      if (enabled) drag.begin(idHex)(e.nativeEvent);
    },
    [enabled, drag],
  );

  return {
    sourceIdHex: drag.source,
    dragging: drag.dragging,
    target,
    indicatorY,
    columnX,
    pointer,
    /** Ref for the scrolling channel column. Carries the touchmove canceller. */
    attachColumn: drag.attachContainer,
    shouldSuppressClick: drag.shouldSuppressClick,
    onPointerDown,
  };
}
