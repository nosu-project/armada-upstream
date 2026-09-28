import { useState } from "react";

import { FileAttachment } from "@/components/chat/FileAttachment";
import { MediaSpoilerCover } from "@/components/chat/MediaSpoiler";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import {
  isImageAttachment,
  pinAttachmentEntries,
  sizeBytes,
} from "@/concord/lib/pinAttachments";
import type { ImetaEntry } from "@/lib/imeta";
import { cn } from "@/lib/utils";

/**
 * A pin's attachments INLINE: keyless readers can't jump to context, but the
 * blob key rides in `imeta` inside the proof. Capped.
 */

const MAX_INLINE = 4;
const PREVIEW_CLASS = "max-h-32 max-w-full rounded object-contain";

function PinImage({ entry, onOpen }: { entry: ImetaEntry; onOpen?: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const { resolved, onError, failed } = useMediaWithFallback({
    url: entry.url,
    encryption: entry.encryption,
    mime: entry.mime,
    fallbacks: entry.fallbacks,
  });
  const src = resolved.status === "ready" ? resolved.src : undefined;

  if (failed) {
    // Fall back to the download card (also for oversized blobs).
    return (
      <FileAttachment
        url={entry.url}
        mime={entry.mime}
        name={entry.name}
        size={sizeBytes(entry.size)}
        encryption={entry.encryption}
      />
    );
  }
  // The bar opens for everyone unprompted, so keep spoilers covered.
  const cover = entry.spoiler && !revealed
    ? <MediaSpoilerCover compact onReveal={() => setRevealed(true)} />
    : null;
  if (!src) {
    return (
      <div className={cn(PREVIEW_CLASS, "relative h-16 w-24 overflow-hidden", !cover && "animate-pulse bg-foreground/10", cover && "bg-foreground/10")} aria-hidden={!cover}>
        {cover}
      </div>
    );
  }
  const img = (
    <img
      src={src}
      alt={cover ? "" : (entry.name ?? "Pinned image")}
      aria-hidden={cover ? true : undefined}
      loading="lazy"
      className={PREVIEW_CLASS}
      onError={onError}
    />
  );
  // Link to the remote URL, never the blob: a blob with a sender-chosen mime
  // opens same-origin. While covered, the cover is the only way in.
  return onOpen ? (
    <button
      type="button"
      onClick={cover ? undefined : onOpen}
      tabIndex={cover ? -1 : undefined}
      className="relative block cursor-zoom-in overflow-hidden rounded"
    >
      {img}
      {cover}
    </button>
  ) : (
    <a
      href={cover ? undefined : entry.url}
      target="_blank"
      rel="noopener noreferrer"
      className="relative block overflow-hidden rounded"
    >
      {img}
      {cover}
    </a>
  );
}

export function PinAttachments({
  content,
  tags,
  onOpenImage,
}: {
  content: string;
  tags: string[][];
  onOpenImage?: (indexWithinPin: number) => void;
}) {
  const entries = pinAttachmentEntries(content, tags);
  if (entries.length === 0) return null;

  let imageIndex = -1;
  const shown = entries.slice(0, MAX_INLINE);
  const hidden = entries.length - shown.length;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {shown.map((entry) => {
        if (isImageAttachment(entry)) {
          imageIndex += 1;
          const at = imageIndex;
          return <PinImage key={entry.url} entry={entry} onOpen={onOpenImage ? () => onOpenImage(at) : undefined} />;
        }
        return (
          <FileAttachment
            key={entry.url}
            url={entry.url}
            mime={entry.mime}
            name={entry.name}
            size={sizeBytes(entry.size)}
            encryption={entry.encryption}
            className="max-w-full"
          />
        );
      })}
      {hidden > 0 && (
        <span className="text-[11px] text-muted-foreground">+{hidden} more</span>
      )}
    </div>
  );
}
