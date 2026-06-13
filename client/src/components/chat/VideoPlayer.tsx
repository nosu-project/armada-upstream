import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

interface VideoPlayerProps {
  src: string;
  /** Poster image URL (from the imeta `image` field). */
  poster?: string;
  /** Pixel dimensions from the imeta `dim` field, e.g. "1280x720". */
  dim?: string;
  className?: string;
}

/**
 * Inline chat video player. Uses native controls but reserves the correct
 * aspect ratio from imeta `dim` to prevent layout shifts.
 */
export function VideoPlayer({ src, poster, dim, className }: VideoPlayerProps) {
  const [failed, setFailed] = useState(false);

  const aspectRatio = useMemo(() => {
    const match = dim?.match(/^(\d+)x(\d+)$/);
    if (match) {
      const w = Number.parseInt(match[1], 10);
      const h = Number.parseInt(match[2], 10);
      if (w > 0 && h > 0) return `${w} / ${h}`;
    }
    return "16 / 9";
  }, [dim]);

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {src}
      </a>
    );
  }

  return (
    <div
      className={cn("my-1.5 max-w-md rounded-xl overflow-hidden border border-border bg-black", className)}
      style={{ aspectRatio }}
      onClick={(e) => e.stopPropagation()}
    >
      <video
        src={src}
        poster={poster}
        controls
        preload="metadata"
        playsInline
        className="w-full h-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
