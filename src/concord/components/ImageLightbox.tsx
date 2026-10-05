import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

import { useOverlayBack } from "@/hooks/useAndroidBack";
import { useSwipeToDismiss } from "@/hooks/useSwipeToDismiss";

/** Fullscreen viewer for a decrypted image URL; swipe-to-dismiss like the chat `Lightbox`. */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const { containerRef, handlers } = useSwipeToDismiss(onClose);

  // System back closes the lightbox instead of navigating.
  useOverlayBack(() => {
    onClose();
    return true;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={containerRef}
      className="fixed inset-0 z-[300]"
      onClick={onClose}
      {...handlers}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-black/90" />

      <div data-lightbox-content className="absolute inset-0 flex items-center justify-center">
        <button
          type="button"
          aria-label="Close"
          className="absolute top-safe-4 right-4 p-2 touch:p-2.5 clip-corner-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
          onClick={onClose}
        >
          <X className="size-6" />
        </button>
        <img
          src={src}
          alt=""
          draggable={false}
          className="max-w-[95vw] max-h-[92vh] object-contain select-none"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  );
}
