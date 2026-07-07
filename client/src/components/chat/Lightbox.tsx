import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";

import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";

interface LightboxProps {
  images: EncryptedRef[];
  currentIndex: number;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
}

/** Easing + duration for the swipe-to-dismiss commit/spring-back animation. */
const EASING = "cubic-bezier(0.25, 0.46, 0.45, 0.94)";
const DURATION = 280;

/** Fullscreen image lightbox with keyboard navigation + swipe-to-dismiss.
 *
 * Drag the image vertically (up or down) to dismiss: past 15% of the viewport
 * height commits (the content flies off-screen and closes), otherwise it
 * springs back. The backdrop fades with drag distance. Modeled on Ditto's
 * lightbox — refs + direct DOM mutation (no React state) so the drag tracks the
 * finger at 60fps without re-rendering. */
export function Lightbox({ images, currentIndex, onClose, onNext, onPrev }: LightboxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Drag origin (null when not dragging) + the locked gesture axis.
  const dragX = useRef<number | null>(null);
  const dragY = useRef<number | null>(null);
  const axis = useRef<"h" | "v" | null>(null);
  const animating = useRef(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onNext();
      else if (e.key === "ArrowLeft") onPrev();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, onNext, onPrev]);

  const image = images[currentIndex];
  // Hooks must run unconditionally; resolve even when index is out of range
  // (falls back to a stable empty ref).
  const resolved = useResolvedMediaSrc(image ?? { url: "" });

  /** Translate the content layer by `offsetY` and fade the backdrop with drag
   *  distance. The backdrop fades in place; only the content translates. */
  const applyVerticalDismiss = useCallback((offsetY: number, transition: string) => {
    const el = containerRef.current;
    if (!el) return;
    const progress = Math.min(Math.abs(offsetY) / (window.innerHeight * 0.4), 1);
    // Reuse the drag transition's duration/easing for the opacity fade.
    el.style.transition = transition ? `opacity ${transition.split(" ").slice(1).join(" ")}` : "none";
    el.style.opacity = String(1 - progress * 0.6);
    const content = el.querySelector<HTMLDivElement>("[data-lightbox-content]");
    if (content) {
      content.style.transition = transition;
      content.style.transform = `translateY(${offsetY}px)`;
    }
  }, []);

  const onTouchStart = (e: React.TouchEvent) => {
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
    applyVerticalDismiss(0, "none");
  };

  // touchmove must be a non-passive listener so we can preventDefault() the
  // vertical drag (otherwise the page/scroll fights the gesture).
  const onTouchMoveRef = useRef((_e: TouchEvent) => {});
  onTouchMoveRef.current = (e: TouchEvent) => {
    if (dragX.current === null || dragY.current === null || animating.current) return;
    const dx = e.touches[0].clientX - dragX.current;
    const dy = e.touches[0].clientY - dragY.current;
    if (!axis.current) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // dead zone
      axis.current = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
    }
    // Only vertical drag dismisses; horizontal is left to the nav buttons.
    if (axis.current !== "v") return;
    e.preventDefault();
    applyVerticalDismiss(dy, "none");
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: TouchEvent) => onTouchMoveRef.current(e);
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, []);

  const onTouchEnd = (e: React.TouchEvent) => {
    if (axis.current === "v" && dragY.current !== null) {
      const dy = e.changedTouches[0].clientY - dragY.current;
      dragX.current = null;
      dragY.current = null;
      axis.current = null;
      const committed = Math.abs(dy) > window.innerHeight * 0.15;
      if (committed) {
        animating.current = true;
        const targetY = dy > 0 ? window.innerHeight : -window.innerHeight;
        applyVerticalDismiss(targetY, `transform ${DURATION}ms ${EASING}`);
        setTimeout(() => {
          onClose();
          animating.current = false;
        }, DURATION);
      } else {
        applyVerticalDismiss(0, `transform ${DURATION}ms ${EASING}`);
      }
      return;
    }
    dragX.current = null;
    dragY.current = null;
    axis.current = null;
  };

  if (!image) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-[200]"
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop — fades in place, never translates. */}
      <div className="absolute inset-0 bg-black/90" />

      {/* Content layer — translates together during swipe-to-dismiss. */}
      <div data-lightbox-content className="absolute inset-0 flex items-center justify-center">
        <button
          type="button"
          aria-label="Close"
          className="absolute top-safe-4 right-4 p-2 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          onClick={onClose}
        >
          <X className="size-6" />
        </button>

        {images.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous image"
              className="absolute left-2 p-2 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onPrev();
              }}
            >
              <ChevronLeft className="size-7" />
            </button>
            <button
              type="button"
              aria-label="Next image"
              className="absolute right-2 p-2 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onNext();
              }}
            >
              <ChevronRight className="size-7" />
            </button>
            <span className="absolute bottom-4 text-white/70 text-xs tabular-nums">
              {currentIndex + 1} / {images.length}
            </span>
          </>
        )}

        {resolved.status === "ready" && (
          <img
            src={resolved.src}
            alt=""
            draggable={false}
            className="max-w-[95vw] max-h-[92vh] object-contain select-none"
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
