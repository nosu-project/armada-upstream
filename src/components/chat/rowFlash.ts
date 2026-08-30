/**
 * Centering + highlighting a jumped-to message row.
 *
 * Shared by the main timeline and the thread panel because a permalink can
 * name either surface (`/m/<id>` vs `/t/<root>/m/<id>`), and arriving at a
 * reply should look exactly like arriving at a timeline message — same wash,
 * same duration, same "this exact one" bar.
 */

/** The permalink indicator: an inset shadow, so nothing shifts when it lands. */
const INDICATOR = "shadow-[inset_3px_0_0_0_hsl(var(--primary))]";

/**
 * The row's own scroller: the nearest ancestor that actually scrolls
 * vertically.
 *
 * This exists because `scrollIntoView` is not scoped to one element — it walks
 * EVERY scrollable ancestor and scrolls each one until the target is in view,
 * on BOTH axes. `block: "center"` only chooses the vertical alignment; the
 * horizontal axis still defaults to `inline: "nearest"`. On the mobile chat
 * layout that is a live hazard rather than a theoretical one: `SwipeReveal`
 * parks the chat pane at `translateX(100vw)` when the channel list is
 * revealed, which extends the shell's scrollable width to twice the viewport,
 * and the shell is `overflow: hidden` — which still creates a SCROLL
 * CONTAINER, one the user cannot scroll but the browser can. Centering a
 * permalink row inside that parked pane therefore scrolled the whole shell
 * sideways by a viewport, leaving the (pointer-events-none, because React
 * correctly believed it revealed) chat pane covering the screen and the
 * interactive list off-view except for a sliver. Nothing ever resets that
 * scroll, so the app took no touch input again until it was force-killed.
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

/**
 * Center `row` in {@link ownScroller} by writing that one element's
 * `scrollTop`. Equivalent to `scrollIntoView({ block: "center" })` for the
 * scroller that owns the row, and inert for every other element on the page —
 * which is the whole point. A row with no scrolling ancestor is left alone
 * rather than scrolling something further up.
 */
function centerInScroller(row: HTMLElement): void {
  const scroller = ownScroller(row);
  if (!scroller) return;
  const rowBox = row.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  const offsetWithin = rowBox.top - scrollerBox.top + scroller.scrollTop;
  scroller.scrollTop = offsetWithin - (scroller.clientHeight - rowBox.height) / 2;
}

/**
 * Center `row` in its scroller and flash a highlight over it.
 *
 * `focus` marks the row as a permalink target rather than an in-room jump: it
 * additionally gets a primary bar beside it that outlives the background wash,
 * because the arriving reader needs "this exact message" to survive the first
 * moment, where an in-room jump only needs a flash.
 */
export function flashRow(row: HTMLElement, focus = false): void {
  // Rows above the target that have never been painted are still sitting at
  // their `contain-intrinsic-size` estimate, and images/embeds resolve a frame
  // or two late, so the first scroll lands approximately; re-centering on the
  // next two frames settles it. Bounded, unlike polling for the row to appear.
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
