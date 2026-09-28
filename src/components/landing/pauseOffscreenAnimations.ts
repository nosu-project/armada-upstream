import { useEffect, type RefObject } from "react";

/**
 * The deck's looping CSS animations (status LEDs, carets, the drifting answer
 * cards…), matched by the `_infinite` in their Tailwind arbitrary class.
 */
const LOOPING = '[class*="_infinite"]';
/** Resume a little before an element scrolls in, so it is never seen paused. */
const MARGIN = "200px 0px";
/** Coalesces a burst of DOM changes (a typing demo, a quiz step) into one scan. */
const RESCAN_MS = 250;

/**
 * Pause every looping CSS animation under `rootRef` while it is off screen.
 *
 * Chromium keeps ticking an infinite animation whose element is scrolled out
 * of view, and a `steps()` or `step-end` one restyles the element on every
 * step — the relay LEDs far down the deck alone cost ~12 style recalcs a
 * second on an idle landing page. Nobody can see an off-screen blink, so
 * pausing it changes nothing on screen; `TvDrum` and `EncryptionQuiz` already
 * gate their own this way, and this covers the rest without each component
 * having to.
 *
 * The pause is an inline `animation-play-state`, cleared (not set to
 * `running`) on the way back in, so a component's own class-based gating is
 * what applies while its element is visible.
 */
export function usePauseOffscreenAnimations(
  rootRef: RefObject<HTMLElement | null>,
  /**
   * The container the deck scrolls in. The observer is rooted on it because a
   * scroller clips a viewport-rooted observer at its own edge, which would
   * make the resume margin a no-op.
   */
  scrollRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          (entry.target as HTMLElement).style.animationPlayState = entry.isIntersecting ? "" : "paused";
        }
      },
      { root: scrollRef.current, rootMargin: MARGIN },
    );

    const watched = new Set<Element>();
    const scan = () => {
      for (const el of watched) {
        if (el.isConnected) continue;
        io.unobserve(el);
        watched.delete(el);
      }
      for (const el of root.querySelectorAll(LOOPING)) {
        if (watched.has(el)) continue;
        watched.add(el);
        io.observe(el);
      }
    };
    scan();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        scan();
      }, RESCAN_MS);
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

    return () => {
      mo.disconnect();
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [rootRef, scrollRef]);
}
