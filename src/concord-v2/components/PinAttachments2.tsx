import { useState } from "react";

import { FileAttachment } from "@/components/chat/FileAttachment";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import {
  isImageAttachment,
  pinAttachmentEntries,
  sizeBytes,
} from "@/concord-v2/lib/pinAttachments";
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

/** One image, decrypted client-side when the imeta carried a key. */
function PinImage({ entry, onOpen }: { entry: ImetaEntry; onOpen?: () => void }) {
  const resolved = useResolvedMediaSrc(
    entry.encryption ? { url: entry.url, encryption: entry.encryption, mime: entry.mime } : entry.url,
  );
  const [broken, setBroken] = useState(false);
  const src = resolved.status === "ready" ? resolved.src : undefined;

  if (broken || resolved.status === "error") {
    // Never a dead end: fall back to the download affordance, which fetches
    // and decrypts by the same route.
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
  if (!src) {
    return <div className={cn(PREVIEW_CLASS, "h-16 w-24 animate-pulse bg-foreground/10")} aria-hidden />;
  }
  const img = (
    <img
      src={src}
      alt={entry.name ?? "Pinned image"}
      loading="lazy"
      className={PREVIEW_CLASS}
      onError={() => setBroken(true)}
    />
  );
  // The shared gallery when the bar offers one — the same surface an in-chat
  // image opens (swipe, zoom, download) — and a plain link otherwise. The link
  // goes to the remote URL, never the resolved blob: a blob carries the mime
  // the SENDER chose and opens same-origin, so navigating to one hands them a
  // document in our own origin.
  return onOpen ? (
    <button type="button" onClick={onOpen} className="block cursor-zoom-in">
      {img}
    </button>
  ) : (
    <a href={entry.url} target="_blank" rel="noopener noreferrer" className="block">
      {img}
    </a>
  );
}

export function PinAttachments2({
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
