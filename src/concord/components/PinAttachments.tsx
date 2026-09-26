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
 * A pinned message's attachments, rendered INLINE.
 *
 * A pin is often the only place a keyless reader can reach this content: they
 * hold none of the Channel's history, so jump-to-context is unavailable to
 * them and the message exists nowhere else they can look. The blob's own
 * decryption key rides in the message's `imeta` tags, which sit INSIDE the
 * proof — so a reader who cannot decrypt a single chat message can still fetch
 * and open this file, and know it is the file the author attached.
 *
 * Deliberately capped: a pin bar is a summary, not a gallery.
 */

/** At most this many attachments render; the rest are counted. */
const MAX_INLINE = 4;
/** Preview box height — enough to recognise an image, not enough to take over. */
const PREVIEW_CLASS = "max-h-32 max-w-full rounded object-contain";

/** One image, decrypted client-side when the imeta carried a key, walked across mirrors like the timeline's. */
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
    // Never a dead end: fall back to the download affordance, which fetches
    // and decrypts by the same route. That is also the right landing place for
    // an oversized blob — a pin preview is not worth tens of megabytes unasked,
    // but the card makes the whole file one deliberate tap away.
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
  // A spoiler stays covered in the pin bar as it does in the timeline: the
  // bar opens for every member, unprompted, so it is the last place to show
  // what the sender hid.
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
  // The shared gallery when the bar offers one — the same surface an in-chat
  // image opens (swipe, zoom, download) — and a plain link otherwise. The link
  // goes to the remote URL, never the resolved blob: a blob carries the mime
  // the SENDER chose and opens same-origin, so navigating to one hands them a
  // document in our own origin.
  // While covered, the cover is the only way in: no click or tab stop on the
  // gallery button, and no href on the link (one without is not focusable).
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
  /** Open the shared gallery at this pin's Nth image. */
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
