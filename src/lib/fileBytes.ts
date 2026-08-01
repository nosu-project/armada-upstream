/**
 * Byte/filename plumbing shared by the save-to-device and share-a-file paths.
 *
 * Lives apart from either so `share.ts` and `downloadFile.ts` can both use it
 * without importing each other (`downloadFile` already falls back to
 * `share.openUrl`, and a cycle back the other way is a trap waiting to spring
 * on module-init order).
 */

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
