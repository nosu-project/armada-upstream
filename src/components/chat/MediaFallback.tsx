import { ExternalLink, ImageOff, RotateCw } from "lucide-react";

import { cn } from "@/lib/utils";

interface MediaFallbackProps {
  /** The original media URL — the target of the "open" action. */
  url: string;
  /** Restart the load from the first server (manual retry). */
  onRetry: () => void;
  /** What the missing media is, e.g. "Image" / "Video" / "Audio". */
  label?: string;
  className?: string;
  /**
   * Fill a fixed tile (image grid cell) instead of rendering a card: the whole
   * tile becomes the retry target with a centered icon, since there is no room
   * for label + actions there.
   */
  compact?: boolean;
}

/**
 * The placeholder an image/video/audio embed degrades to once EVERY mirror has
 * failed (see {@link useMediaWithFallback}) — a broken-media icon, a short
 * label, and retry + open actions, rather than a raw URL dumped inline.
 *
 * Block-level by default so it takes its own line: the tokenizer strips the
 * whitespace around a media block expecting one, so an inline fallback would
 * glue onto adjacent text. The retry covers the transient case (a server that
 * was down and is back, recovered network) that automatic cross-server fallback
 * couldn't outlast; open is the escape hatch to the original URL.
 */
export function MediaFallback({ url, onRetry, label = "Media", className, compact = false }: MediaFallbackProps) {
  const retry = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onRetry();
  };

  if (compact) {
    return (
      <button
        type="button"
        onClick={retry}
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted text-muted-foreground hover:text-foreground transition-colors",
          className,
        )}
        title={`${label} unavailable — tap to retry`}
        aria-label={`Retry loading ${label.toLowerCase()}`}
      >
        <ImageOff className="size-5" />
        <span className="text-[10px]">Retry</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "my-1.5 flex max-w-sm items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <ImageOff className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">{label} unavailable</span>
      <button
        type="button"
        onClick={retry}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title="Retry"
        aria-label={`Retry loading ${label.toLowerCase()}`}
      >
        <RotateCw className="size-4" />
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title="Open in a new tab"
        aria-label="Open in a new tab"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="size-4" />
      </a>
    </div>
  );
}
