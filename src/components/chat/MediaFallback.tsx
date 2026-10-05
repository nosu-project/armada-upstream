import { ExternalLink, ImageOff, Lock, RotateCw } from "lucide-react";

import { formatBytes } from "@/lib/fileBytes";
import { cn } from "@/lib/utils";

export interface MediaFallbackProps {
  /** The original media URL — the target of the "open" action. */
  url: string;
  onRetry: () => void;
  /** Encrypted blob over the inline decrypt cap: its size in bytes (readable, just not auto-decrypted). */
  oversized?: number;
  onDecryptAnyway?: () => void;
  /** What the missing media is, e.g. "Image" / "Video" / "Audio". */
  label?: string;
  className?: string;
  /** Fill a fixed grid tile: the whole tile is the retry target. */
  compact?: boolean;
}

/**
 * Placeholder once EVERY mirror fails (see {@link useMediaWithFallback}): retry
 * + open. Block-level since the tokenizer stripped surrounding whitespace.
 */
export function MediaFallback({
  url,
  onRetry,
  oversized,
  onDecryptAnyway,
  label = "Media",
  className,
  compact = false,
}: MediaFallbackProps) {
  const retry = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onRetry();
  };

  // Not a failure: offer "decrypt anyway" and state the size.
  if (oversized !== undefined && onDecryptAnyway) {
    const decrypt = (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onDecryptAnyway();
    };

    if (compact) {
      return (
        <button
          type="button"
          onClick={decrypt}
          className={cn(
            "absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted text-muted-foreground hover:text-foreground transition-colors",
            className,
          )}
          title={`${label} is ${formatBytes(oversized)}. Tap to decrypt anyway`}
          aria-label={`Decrypt ${label.toLowerCase()} anyway`}
        >
          <Lock className="size-5" />
          <span className="text-3xs">{formatBytes(oversized)}</span>
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
        <Lock className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm text-muted-foreground">
          {label} is large ({formatBytes(oversized)})
        </span>
        <button
          type="button"
          onClick={decrypt}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors touch:min-h-11"
        >
          Decrypt anyway
        </button>
      </div>
    );
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={retry}
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-1 bg-muted text-muted-foreground hover:text-foreground transition-colors",
          className,
        )}
        title={`${label} unavailable. Tap to retry`}
        aria-label={`Retry loading ${label.toLowerCase()}`}
      >
        <ImageOff className="size-5" />
        <span className="text-3xs">Retry</span>
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
