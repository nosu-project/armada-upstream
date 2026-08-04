import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import { parseImetaMap, type ImetaEntry } from "@/lib/imeta";
import { isLocalNetworkUrl, sanitizeUrl } from "@/lib/sanitizeUrl";

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
  // SVG is a document that can carry script, and a pin renders inline for
  // every member of the channel, unprompted, for as long as the pin exists.
  // It stays an attachment: downloadable, never auto-rendered.
  if (entry.mime === "image/svg+xml") return false;
  if (entry.mime?.startsWith("image/")) return true;
  if (entry.mime) return false;
  return /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(entry.url);
}

/** Every attachment a pinned message carries, imeta first, bare URLs as fallback. */
export function pinAttachmentEntries(content: string, tags: string[][]): ImetaEntry[] {
  // parseImetaMap does no scheme validation, and every one of these URLs came
  // from a member's message and was chosen by a curator. The chat timeline
  // sanitizes both imeta paths; pins must not be the one renderer that skips
  // it, or a `javascript:` imeta reaches an <img src>/<a href>. Local-network
  // hosts are dropped too — a pinned http://192.168.x.x prompts every viewer
  // on every channel open, forever.
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

/** Just the images, as the Lightbox's ref shape. */
export function pinImageRefs(content: string, tags: string[][]): EncryptedRef[] {
  return pinAttachmentEntries(content, tags)
    .filter(isImageAttachment)
    .map((e) => ({ url: e.url, encryption: e.encryption, mime: e.mime, blurhash: e.blurhash }));
}
