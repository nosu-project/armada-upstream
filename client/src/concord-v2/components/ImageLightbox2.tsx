import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

/** Fullscreen viewer for a single already-decrypted image URL (Escape / click to close). */
export function ImageLightbox2({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] bg-black/90 flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute top-safe-4 right-4 p-2 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        onClick={onClose}
      >
        <X className="size-6" />
      </button>
      <img
        src={src}
        alt=""
        className="max-w-[95vw] max-h-[92vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
