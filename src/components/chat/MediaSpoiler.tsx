import { EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The cover over a spoilered attachment, Discord-style: the media underneath is
 * blurred out of recognition until the cover is clicked, and the click that
 * reveals it does nothing else — it must not also open the lightbox or start
 * the video the cover sits on.
 *
 * Rendered INSIDE the media's own box (which must be `relative`), so it takes
 * the box's exact geometry and the layout doesn't move on reveal. A span, not a
 * button, because the image it covers is usually already a button.
 */
export function MediaSpoilerCover({ onReveal, compact = false }: { onReveal: () => void; compact?: boolean }) {
  const reveal = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onReveal();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="Reveal spoiler"
      onClick={reveal}
      // Swallow the press too, so a long-press menu or a video's own
      // pointer handling underneath never sees the gesture.
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") reveal(e);
      }}
      className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/40 backdrop-blur-3xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-full bg-black/70 font-bold tracking-wide text-white",
          compact ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-xs",
        )}
      >
        {!compact && <EyeOff className="size-3.5" />}
        SPOILER
      </span>
    </span>
  );
}
