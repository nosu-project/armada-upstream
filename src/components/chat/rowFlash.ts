/**
 * Centering + highlighting a jumped-to row, shared by the timeline and thread
 * panel so both permalink shapes look identical.
 */

/** The permalink indicator: an inset shadow, so nothing shifts when it lands. */
const INDICATOR = "shadow-[inset_3px_0_0_0_hsl(var(--primary))]";

/**
 * The row's own vertical scroller. Avoids `scrollIntoView`, which scrolls EVERY
 * ancestor on both axes: on mobile it scrolled the `overflow: hidden` shell
 * sideways past SwipeReveal's parked pane, freezing touch input until restart.
 */
function ownScroller(row: HTMLElement): HTMLElement | null {
  let node = row.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Center `row` by writing only its own scroller's `scrollTop`; no scroller, no scroll. */
function centerInScroller(row: HTMLElement): void {
  const scroller = ownScroller(row);
  if (!scroller) return;
  const rowBox = row.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  const offsetWithin = rowBox.top - scrollerBox.top + scroller.scrollTop;
  scroller.scrollTop = offsetWithin - (scroller.clientHeight - rowBox.height) / 2;
}

/**
 * Center and flash `row`. `focus` (a permalink target) adds a primary bar that
 * outlasts the wash.
 */
export function flashRow(row: HTMLElement, focus = false): void {
  // Unpainted rows above sit at their `contain-intrinsic-size` estimate and media
  // resolves late, so re-center on the next two frames.
  centerInScroller(row);
  requestAnimationFrame(() => {
    centerInScroller(row);
    requestAnimationFrame(() => centerInScroller(row));
  });
  row.classList.add("bg-primary/10", "transition-colors", "duration-1000", "rounded-md");
  if (focus) row.classList.add(INDICATOR);
  const washMs = focus ? 2200 : 1200;
  setTimeout(() => row.classList.remove("bg-primary/10"), washMs);
  setTimeout(() => {
    row.classList.remove("transition-colors", "duration-1000", "rounded-md", INDICATOR);
  }, washMs + 1000);
}
