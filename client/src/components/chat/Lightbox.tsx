import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { useSwipeToDismiss } from "@/hooks/useSwipeToDismiss";

import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";

interface LightboxProps {
  images: EncryptedRef[];
  currentIndex: number;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
}

/** Fullscreen image lightbox with keyboard navigation + swipe-to-dismiss.
 *
 * On touch, drag the image vertically to dismiss (see `useSwipeToDismiss`);
 * horizontal drags are left to the prev/next nav buttons. */
export function Lightbox({ images, currentIndex, onClose, onNext, onPrev }: LightboxProps) {
  const { containerRef, handlers } = useSwipeToDismiss(onClose);

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

  if (!image) return null;

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-[200]"
      onClick={onClose}
      {...handlers}
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
