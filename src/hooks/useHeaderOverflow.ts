import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Measure whether a horizontal container has run out of room for its contents.
 *
 * Used by the channel header to gracefully overflow its lower-priority actions
 * (pins, events) into the channel-info menu when the screen can't fit them all
 * — e.g. an admin channel with voice + pins + events on a 320px iPhone SE.
 * Rather than a fixed breakpoint (which mis-collapses because the action set is
 * conditional), this watches the actual element with a ResizeObserver and
 * reports how many of the optional, collapsible actions have to fold away.
 *
 * The caller renders the bar at its *fullest* (all actions inline), and this
 * hook reports `overflowCount` — how many collapsible items, counted from the
 * lowest priority, don't fit. The caller then moves that many into the menu and
 * re-measures. A small hysteresis gap prevents flicker at the boundary (an item
 * must clearly fit again before it pops back inline).
 *
 * @param collapsibleCount total number of optional actions that may be folded
 * @param itemWidth approximate px width freed per collapsed item (button + gap).
 *   Deliberately a slight *over*-estimate of the real freed width: restoring a
 *   collapsed item requires at least this much slack, so an item never pops
 *   back inline only to immediately overflow again (which would oscillate).
 */
export function useHeaderOverflow(collapsibleCount: number, itemWidth = 52) {
  const ref = useRef<HTMLElement | null>(null);
  const [overflowCount, setOverflowCount] = useState(0);
  // Keep the latest count readable inside the observer callback without
  // re-subscribing the observer on every change.
  const overflowRef = useRef(0);
  overflowRef.current = overflowCount;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Overflow when content is wider than the box. `scrollWidth` reflects the
    // full inline layout even while clipped; compare to the visible width.
    const overshoot = el.scrollWidth - el.clientWidth;
    const current = overflowRef.current;

    if (overshoot > 1 && current < collapsibleCount) {
      // Need to collapse more: estimate how many items clears the overshoot,
      // collapse at least one more so we always make progress.
      const needed = Math.ceil(overshoot / itemWidth);
      setOverflowCount(Math.min(collapsibleCount, current + Math.max(1, needed)));
    } else if (overshoot <= 0 && current > 0) {
      // There's slack — try to restore one collapsed item, but only if the
      // slack clearly exceeds an item's width (hysteresis) so it doesn't
      // immediately overflow again and oscillate.
      const slack = el.clientWidth - el.scrollWidth;
      if (slack >= itemWidth) {
        setOverflowCount(current - 1);
      }
    }
  }, [collapsibleCount, itemWidth]);

  // Clamp if the number of collapsible actions shrinks (e.g. the last pin was
  // removed) so we never report more overflow than there are items.
  useEffect(() => {
    setOverflowCount((c) => Math.min(c, collapsibleCount));
  }, [collapsibleCount]);

  // Re-measure synchronously after layout (so a freshly-collapsed item's space
  // is reflected before paint) and whenever the header resizes.
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
