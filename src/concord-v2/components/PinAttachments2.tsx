import { useState } from "react";

import { FileAttachment } from "@/components/chat/FileAttachment";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { parseImetaMap, type ImetaEntry } from "@/lib/imeta";
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

/** imeta carries `size` as a sender-declared string; the label wants a number. */
function sizeBytes(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

function isImage(entry: ImetaEntry): boolean {
  if (entry.mime?.startsWith("image/")) return true;
  if (entry.mime) return false;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(entry.url);
}

/** One image, decrypted client-side when the imeta carried a key. */
function PinImage({ entry }: { entry: ImetaEntry }) {
  const resolved = useResolvedMediaSrc(
    entry.encryption ? { url: entry.url, encryption: entry.encryption, mime: entry.mime } : entry.url,
  );
  const [broken, setBroken] = useState(false);
  const src = resolved.status === "ready" ? resolved.src : undefined;

  if (broken || resolved.status === "error") {
    // Never a dead end: fall back to the download affordance, which fetches
    // and decrypts by the same route.
    return <FileAttachment url={entry.url} mime={entry.mime} name={entry.name} size={sizeBytes(entry.size)} encryption={entry.encryption} />;
  }
  if (!src) {
    return <div className={cn(PREVIEW_CLASS, "h-16 w-24 animate-pulse bg-foreground/10")} aria-hidden />;
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block">
      <img
        src={src}
        alt={entry.name ?? "Pinned image"}
        loading="lazy"
        className={PREVIEW_CLASS}
        onError={() => setBroken(true)}
      />
    </a>
  );
}

export function PinAttachments2({ content, tags }: { content: string; tags: string[][] }) {
  const imeta = parseImetaMap(tags);
  // A message may carry URLs with no imeta at all (a plain link to a file), so
  // fall back to bare URLs found in the content.
  const entries: ImetaEntry[] = [...imeta.values()];
  if (entries.length === 0) {
    for (const url of content.match(/https?:\/\/\S+/g) ?? []) {
      if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mp3|ogg|wav|pdf|zip)(\?|$)/i.test(url)) {
        entries.push({ url });
      }
    }
  }
  if (entries.length === 0) return null;

  const shown = entries.slice(0, MAX_INLINE);
  const hidden = entries.length - shown.length;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {shown.map((entry) =>
        isImage(entry) ? (
          <PinImage key={entry.url} entry={entry} />
        ) : (
          <FileAttachment
            key={entry.url}
            url={entry.url}
            mime={entry.mime}
            name={entry.name}
            size={sizeBytes(entry.size)}
            encryption={entry.encryption}
            className="max-w-full"
          />
        ),
      )}
      {hidden > 0 && (
        <span className="text-[11px] text-muted-foreground">+{hidden} more</span>
      )}
    </div>
  );
}
