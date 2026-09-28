import { useEffect, type RefObject } from "react";

/** Looping CSS animations, matched by `_infinite` in their Tailwind arbitrary class. */
const LOOPING = '[class*="_infinite"]';
const MARGIN = "200px 0px";
const RESCAN_MS = 250;

/**
 * Pause looping CSS animations under `rootRef` while off screen: Chromium keeps
 * restyling off-screen infinite `steps()` animations. The inline pause is
 * cleared (not set to `running`) on return so component-level gating applies.
 */
export function usePauseOffscreenAnimations(
  rootRef: RefObject<HTMLElement | null>,
  /** Observer root: a scroller clips a viewport-rooted observer, defeating the margin. */
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
