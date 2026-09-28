import { useCallback, useEffect, useRef } from "react";

const EASING = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";
const DURATION = 280;
/** Fraction of viewport height past which a release dismisses. */
const COMMIT_FRACTION = 0.15;

export interface SwipeToDismiss {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Spread onto the container: `<div {...handlers} />`. */
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
  };
}

/**
 * Vertical swipe-to-dismiss for lightboxes (modeled on Ditto): refs + direct DOM writes, no
 * React state. Needs a backdrop that fades in place and one `[data-lightbox-content]` layer that
 * translates. Horizontal drags are left to the caller.
 */
export function useSwipeToDismiss(onClose: () => void): SwipeToDismiss {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragX = useRef<number | null>(null);
  const dragY = useRef<number | null>(null);
  const axis = useRef<"h" | "v" | null>(null);
  const animating = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /** Only the content translates; the backdrop fades in place. */
  const apply = useCallback((offsetY: number, transition: string) => {
    const el = containerRef.current;
    if (!el) return;
    const progress = Math.min(Math.abs(offsetY) / (window.innerHeight * 0.4), 1);
    el.style.transition = transition ? `opacity ${DURATION}ms ${EASING}` : "none";
    el.style.opacity = String(1 - progress * 0.6);
    const content = el.querySelector<HTMLDivElement>("[data-lightbox-content]");
    if (content) {
      content.style.transition = transition;
      content.style.transform = `translateY(${offsetY}px)`;
    }
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (animating.current) return;
      // A pinch/second finger cancels the swipe.
      if (e.touches.length >= 2) {
        dragX.current = null;
        dragY.current = null;
        return;
      }
      dragX.current = e.touches[0].clientX;
      dragY.current = e.touches[0].clientY;
      axis.current = null;
      apply(0, "none");
    },
    [apply],
  );

  // Non-passive so the vertical drag can preventDefault.
  const onTouchMoveRef = useRef((_e: TouchEvent) => {});
  onTouchMoveRef.current = (e: TouchEvent) => {
    if (dragX.current === null || dragY.current === null || animating.current) return;
    const dx = e.touches[0].clientX - dragX.current;
    const dy = e.touches[0].clientY - dragY.current;
    if (!axis.current) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // dead zone
      axis.current = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
    }
    if (axis.current !== "v") return;
    e.preventDefault();
    apply(dy, "none");
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: TouchEvent) => onTouchMoveRef.current(e);
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (axis.current === "v" && dragY.current !== null) {
        const dy = e.changedTouches[0].clientY - dragY.current;
        dragX.current = null;
        dragY.current = null;
        axis.current = null;
        const committed = Math.abs(dy) > window.innerHeight * COMMIT_FRACTION;
        if (committed) {
          animating.current = true;
          const targetY = dy > 0 ? window.innerHeight : -window.innerHeight;
          apply(targetY, `transform ${DURATION}ms ${EASING}`);
          setTimeout(() => {
            onCloseRef.current();
            animating.current = false;
          }, DURATION);
        } else {
          apply(0, `transform ${DURATION}ms ${EASING}`);
        }
        return;
      }
      dragX.current = null;
      dragY.current = null;
      axis.current = null;
    },
    [apply],
  );

  return { containerRef, handlers: { onTouchStart, onTouchEnd } };
}
