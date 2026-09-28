import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import { parseImetaMap, type ImetaEntry } from "@/lib/imeta";
import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

/**
 * Attachment extraction for pinned messages (pure, for tests/fast refresh). A pin
 * may be a keyless reader's only access to the content; the blob key rides in
 * `imeta` inside the proof, so they can still open the file.
 */

/** imeta carries `size` as a sender-declared string; the label wants a number. */
export function sizeBytes(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function isImageAttachment(entry: ImetaEntry): boolean {
  // SVG can carry script and pins render unprompted for everyone: download only.
  if (entry.mime === "image/svg+xml") return false;
  if (entry.mime?.startsWith("image/")) return true;
  if (entry.mime) return false;
  return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(entry.url);
}

/** Every attachment a pinned message carries, imeta first, bare URLs as fallback. */
export function pinAttachmentEntries(content: string, tags: string[][]): ImetaEntry[] {
  // Same sanitization as the chat timeline: no `javascript:` imeta into
  // <img src>/<a href>, and no local-network hosts (they'd prompt every viewer).
  const safe = (e: ImetaEntry): ImetaEntry | undefined => {
    const url = sanitizeUrl(e.url);
    if (!url || isLocalNetworkUrl(url)) return undefined;
    const thumbnail = e.thumbnail ? sanitizeUrl(e.thumbnail) : undefined;
    return { ...e, url, thumbnail: thumbnail && !isLocalNetworkUrl(thumbnail) ? thumbnail : undefined };
  };
  const entries: ImetaEntry[] = [...parseImetaMap(tags).values()]
    .map(safe)
    .filter((e): e is ImetaEntry => e !== undefined);
  if (entries.length === 0) {
    for (const url of content.match(/https?:\/\/\S+/g) ?? []) {
      const safeUrl = sanitizeUrl(url);
      if (!safeUrl || isLocalNetworkUrl(safeUrl)) continue;
      if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mp3|ogg|wav|pdf|zip)(\?|$)/i.test(safeUrl)) {
        entries.push({ url: safeUrl });
      }
    }
  }
  return entries;
}

/** Just the images, as Lightbox refs — spoiler included so the gallery respects it. */
export function pinImageRefs(content: string, tags: string[][]): (EncryptedRef & { spoiler?: boolean })[] {
  return pinAttachmentEntries(content, tags)
    .filter(isImageAttachment)
    .map((e) => ({ url: e.url, encryption: e.encryption, mime: e.mime, blurhash: e.blurhash, spoiler: e.spoiler }));
}
