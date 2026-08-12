/**
 * Byte/filename plumbing shared by the save-to-device and share-a-file paths.
 *
 * Lives apart from either so `share.ts` and `downloadFile.ts` can both use it
 * without importing each other (`downloadFile` already falls back to
 * `share.openUrl`, and a cycle back the other way is a trap waiting to spring
 * on module-init order).
 */

/** Human-readable byte size (1024-based). Empty string for a non-size. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** Base64-encode bytes in chunks (avoids arg-count limits on large inputs). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** File extension for a MIME type, when we can infer a common one. */
export function extForMime(mime: string | undefined): string {
  switch ((mime ?? "").toLowerCase().split(";")[0].trim()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/avif":
      return ".avif";
    case "image/heic":
      return ".heic";
    case "image/svg+xml":
      return ".svg";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    default:
      return "";
  }
}

/**
 * Identify a bitmap from its leading bytes.
 *
 * The DECLARED type is routinely absent here: an `imeta` often carries no `m`
 * tag, a Blossom URL is a bare hash with no extension, and a decrypted
 * attachment's Blob inherits that same nothing as `application/octet-stream`
 * (see `encryptedMedia.ts`). A file handed to a share sheet untyped and
 * extensionless previews as a generic document rather than a thumbnail, and
 * some targets refuse it outright — so where the metadata is silent, ask the
 * bytes, which are already in memory by then.
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...bytes.subarray(start, start + len));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ascii(0, 4) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "mif1") return "image/heic";
  }
  return undefined;
}

/**
 * Derive a sensible filename from a URL (and optional MIME hint).
 *
 * Uses the last non-empty path segment (query string stripped). `blob:` and
 * hash-only URLs have no usable name, so fall back to a generic one and, when
 * the segment carries no extension, append one inferred from the MIME.
 */
export function filenameFromUrl(url: string, mime?: string): string {
  let base = "download";
  try {
    const { pathname } = new URL(url);
    const segment = pathname.split("/").filter(Boolean).pop();
    if (segment) base = decodeURIComponent(segment);
  } catch {
    // fall through to the generic name
  }
  if (!/\.[a-z0-9]{2,4}$/i.test(base)) base += extForMime(mime);
  return base;
}
