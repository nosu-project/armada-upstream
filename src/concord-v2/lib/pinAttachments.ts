import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import { parseImetaMap, type ImetaEntry } from "@/lib/imeta";

/**
 * Attachment extraction for pinned messages — pure, so it can be tested and so
 * the component file stays fast-refreshable.
 *
 * A pin is often the only place a keyless reader can reach this content: they
 * hold none of the Channel's history, so jump-to-context is unavailable and the
 * message exists nowhere else they can look. The blob's own AES-GCM key rides
 * in the message's `imeta` tags, which sit INSIDE the proof — so a reader who
 * cannot decrypt a single chat message can still fetch and open the file.
 */

/** imeta carries `size` as a sender-declared string; the label wants a number. */
export function sizeBytes(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function isImageAttachment(entry: ImetaEntry): boolean {
  if (entry.mime?.startsWith("image/")) return true;
  if (entry.mime) return false;
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(entry.url);
}

/** Every attachment a pinned message carries, imeta first, bare URLs as fallback. */
export function pinAttachmentEntries(content: string, tags: string[][]): ImetaEntry[] {
  const entries: ImetaEntry[] = [...parseImetaMap(tags).values()];
  if (entries.length === 0) {
    for (const url of content.match(/https?:\/\/\S+/g) ?? []) {
      if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mp3|ogg|wav|pdf|zip)(\?|$)/i.test(url)) {
        entries.push({ url });
      }
    }
  }
  return entries;
}

/** Just the images, as the Lightbox's ref shape. */
export function pinImageRefs(content: string, tags: string[][]): EncryptedRef[] {
  return pinAttachmentEntries(content, tags)
    .filter(isImageAttachment)
    .map((e) => ({ url: e.url, encryption: e.encryption, mime: e.mime, blurhash: e.blurhash }));
}
