import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Measures how many optional header actions (lowest priority first) must fold into the menu,
 * via ResizeObserver rather than breakpoints (the action set is conditional).
 * @param collapsibleCount total number of optional actions that may be folded
 * @param itemWidth approximate px freed per collapsed item; a slight over-estimate, giving
 *   hysteresis so items don't oscillate.
 */
export function useHeaderOverflow(collapsibleCount: number, itemWidth = 52) {
  const ref = useRef<HTMLElement | null>(null);
  const [overflowCount, setOverflowCount] = useState(0);
  // Readable in the observer callback without re-subscribing.
  const overflowRef = useRef(0);
  overflowRef.current = overflowCount;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overshoot = el.scrollWidth - el.clientWidth;
    const current = overflowRef.current;

    if (overshoot > 1 && current < collapsibleCount) {
      // Always collapse at least one more so we make progress.
      const needed = Math.ceil(overshoot / itemWidth);
      setOverflowCount(Math.min(collapsibleCount, current + Math.max(1, needed)));
    } else if (overshoot <= 0 && current > 0) {
      // Restore only if slack clearly exceeds an item's width (hysteresis).
      const slack = el.clientWidth - el.scrollWidth;
      if (slack >= itemWidth) {
        setOverflowCount(current - 1);
      }
    }
  }, [collapsibleCount, itemWidth]);

  // Clamp when the collapsible count shrinks.
  useEffect(() => {
    setOverflowCount((c) => Math.min(c, collapsibleCount));
  }, [collapsibleCount]);

  // Layout effect so a collapsed item's space is reflected before paint.
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return { ref, overflowCount };
}
