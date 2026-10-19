import { ExternalLink, ImageOff, Lock, RotateCw } from "lucide-react";

import { formatBytes } from "@/lib/fileBytes";
import { cn } from "@/lib/utils";
import { FormattedMessage, common, useIntl } from "@/i18n";

export type MediaFallbackKind = "image" | "video" | "audio" | "gif";

export interface MediaFallbackProps {
  /** The original media URL — the target of the "open" action. */
  url: string;
  onRetry: () => void;
  /** Encrypted blob over the inline decrypt cap: its size in bytes (readable, just not auto-decrypted). */
  oversized?: number;
  onDecryptAnyway?: () => void;
  /** What the missing media is; each message words the noun for its own grammar. */
  kind?: MediaFallbackKind;
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
  kind,
  className,
  compact = false,
}: MediaFallbackProps) {
  const intl = useIntl();
  const kindValue = { kind: kind ?? "other" };
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
          title={intl.formatMessage(
            { id: "mediaFallback.oversizedTitle", defaultMessage: "{kind, select, image {Image is {size}. Tap to decrypt anyway} video {Video is {size}. Tap to decrypt anyway} audio {Audio is {size}. Tap to decrypt anyway} gif {GIF is {size}. Tap to decrypt anyway} other {Media is {size}. Tap to decrypt anyway}}" },
            { ...kindValue, size: formatBytes(oversized) },
          )}
          aria-label={intl.formatMessage(
            { id: "mediaFallback.decryptLabel", defaultMessage: "{kind, select, image {Decrypt image anyway} video {Decrypt video anyway} audio {Decrypt audio anyway} gif {Decrypt GIF anyway} other {Decrypt media anyway}}" },
            kindValue,
          )}
        >
          <Lock className="size-5" />
          <span className="text-3xs">{formatBytes(oversized)}</span>
        </button>
      );
    }

    return (
      <div
        className={cn(
          "my-1.5 flex max-w-sm items-center gap-2.5 clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--muted)/0.4] [--fill-hover:var(--muted)/0.4] px-3 py-2.5",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Lock className="size-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm text-muted-foreground">
          <FormattedMessage
            id="mediaFallback.oversized"
            defaultMessage="{kind, select, image {Image is large ({size})} video {Video is large ({size})} audio {Audio is large ({size})} gif {GIF is large ({size})} other {Media is large ({size})}}"
            values={{ ...kindValue, size: formatBytes(oversized) }}
          />
        </span>
        <button
          type="button"
          onClick={decrypt}
          className="shrink-0 clip-corner-lg px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 transition-colors touch:min-h-11"
        >
          <FormattedMessage id="mediaFallback.decryptAnyway" defaultMessage="Decrypt anyway" />
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
        title={intl.formatMessage(
          { id: "mediaFallback.unavailableTitle", defaultMessage: "{kind, select, image {Image unavailable. Tap to retry} video {Video unavailable. Tap to retry} audio {Audio unavailable. Tap to retry} gif {GIF unavailable. Tap to retry} other {Media unavailable. Tap to retry}}" },
          kindValue,
        )}
        aria-label={intl.formatMessage(
          { id: "mediaFallback.retryLabel", defaultMessage: "{kind, select, image {Retry loading image} video {Retry loading video} audio {Retry loading audio} gif {Retry loading GIF} other {Retry loading media}}" },
          kindValue,
        )}
      >
        <ImageOff className="size-5" />
        <span className="text-3xs"><FormattedMessage {...common.retry} /></span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "my-1.5 flex max-w-sm items-center gap-2.5 clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--muted)/0.4] [--fill-hover:var(--muted)/0.4] px-3 py-2.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <ImageOff className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">
        <FormattedMessage id="mediaFallback.unavailable" defaultMessage="{kind, select, image {Image unavailable} video {Video unavailable} audio {Audio unavailable} gif {GIF unavailable} other {Media unavailable}}" values={kindValue} />
      </span>
      <button
        type="button"
        onClick={retry}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title={intl.formatMessage(common.retry)}
        aria-label={intl.formatMessage(
          { id: "mediaFallback.retryLabel", defaultMessage: "{kind, select, image {Retry loading image} video {Retry loading video} audio {Retry loading audio} gif {Retry loading GIF} other {Retry loading media}}" },
          kindValue,
        )}
      >
        <RotateCw className="size-4" />
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title={intl.formatMessage({ id: "mediaFallback.openInNewTab", defaultMessage: "Open in a new tab" })}
        aria-label={intl.formatMessage({ id: "mediaFallback.openInNewTab", defaultMessage: "Open in a new tab" })}
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="size-4" />
      </a>
    </div>
  );
}
