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
  row.scrollIntoView({ block: "center" });
  requestAnimationFrame(() => {
    row.scrollIntoView({ block: "center" });
    requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
  });
  row.classList.add("bg-primary/10", "transition-colors", "duration-1000", "rounded-md");
  if (focus) row.classList.add(INDICATOR);
  const washMs = focus ? 2200 : 1200;
  setTimeout(() => row.classList.remove("bg-primary/10"), washMs);
  setTimeout(() => {
    row.classList.remove("transition-colors", "duration-1000", "rounded-md", INDICATOR);
  }, washMs + 1000);
}
