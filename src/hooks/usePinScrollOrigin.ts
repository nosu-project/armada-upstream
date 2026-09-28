import { useEffect } from "react";

/**
 * Pin an `overflow: hidden` element's scroll offset at zero. It's still a scroll container,
 * and scrollIntoView/focus/keyboard reflow can scroll it. On mobile, `SwipeReveal` parks the chat
 * pane at `translateX(100vw)`, so such a scroll slides the shell sideways and leaves a
 * `pointer-events: none` pane covering the screen — an app that accepts no input.
 * (`overflow: clip` would avoid this but degrades to `visible` on older iOS.)
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
