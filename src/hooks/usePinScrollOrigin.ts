import { useEffect } from "react";

/**
 * Hold an element that is only meant to CLIP at scroll offset zero.
 *
 * `overflow: hidden` reads like "this cannot scroll", but it still creates a
 * scroll container — the user cannot scroll it, yet the browser freely can, and
 * does, whenever it is asked to bring a descendant into view. `scrollIntoView`
 * is the obvious caller, but so are focusing an input, an anchor jump, and the
 * on-screen keyboard reflowing the page; each walks up the tree scrolling every
 * scrollable ancestor on BOTH axes.
 *
 * On the mobile chat layout that is load-bearing rather than cosmetic.
 * `SwipeReveal` parks the chat pane at `translateX(100vw)` while the channel
 * list is revealed, which doubles the shell's scrollable width. A single
 * scroll-into-view aimed at anything inside that parked pane then slides the
 * whole shell sideways by a viewport — and since React still correctly believes
 * the pane is revealed, that pane keeps `pointer-events: none` while now
 * covering the screen, with the interactive list scrolled out of view behind
 * it. The result is an app that renders and animates normally and accepts no
 * touch input at all, permanently, because nothing ever puts the scroll back.
 *
 * So the offset is pinned: any scroll of this element is a bug by construction,
 * and snapping it back is always right. The listener is passive and only writes
 * when the value is non-zero, so the write it performs cannot re-enter.
 *
 * (`overflow: clip` would prevent this outright by creating no scroll container
 * at all, but it is unsupported on the iOS versions this app still deploys to,
 * where it degrades to `visible` and stops clipping.)
 */
export function usePinScrollOrigin(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reset = () => {
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
      if (el.scrollTop !== 0) el.scrollTop = 0;
    };
    // A scroll may already have happened before this mounted.
    reset();
    el.addEventListener("scroll", reset, { passive: true });
    return () => el.removeEventListener("scroll", reset);
  }, [ref]);
}
