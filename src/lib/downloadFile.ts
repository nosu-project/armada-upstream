import { Capacitor } from "@capacitor/core";

import { openUrl } from "@/lib/share";

/** Base64-encode bytes in chunks (avoids arg-count limits on large inputs). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Save raw bytes to the user's device.
 *
 * Web uses the classic `<a download>` blob trick. On native the anchor pattern
 * silently fails in the WebView, so the bytes are base64-written to the app's
 * Documents directory (visible in the iOS Files app and Android's app-scoped
 * documents) — no storage permission required.
 */
export async function downloadBinaryFile(filename: string, bytes: Uint8Array): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    // No `encoding` → Capacitor treats `data` as base64.
    await Filesystem.writeFile({
      path: filename,
      data: bytesToBase64(bytes),
      directory: Directory.Documents,
    });
  } else {
    const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

/** File extension for a MIME type, when we can infer a common one. */
function extForMime(mime: string | undefined): string {
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
 * Derive a sensible download filename from a URL (and optional MIME hint).
 *
 * Uses the last non-empty path segment (query string stripped). `blob:` and
 * hash-only URLs have no usable name, so fall back to a generic one and, when
 * the segment carries no extension, append one inferred from the MIME.
 */
function filenameFromUrl(url: string, mime?: string): string {
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

/**
 * Save the contents of a media `src` to the user's device.
 *
 * Unlike {@link openUrl}, this saves the file rather than navigating to it — a
 * bare `openUrl` just opens the image in a new tab (web) or does nothing in the
 * native WebView. We fetch the bytes and hand them to {@link downloadBinaryFile}.
 *
 * `src` is the *resolved* media source: a same-origin `blob:` object URL for
 * encrypted / Buzz-authed media (already decrypted in memory, so the fetch is
 * local), or the original `https:` URL for plain media. `nameHint` is the
 * original URL, used only to derive a filename.
 *
 * Returns how the file was delivered so callers can give accurate feedback:
 * `'downloaded'` when saved to disk, or `'opened'` when we had to fall back to
 * opening it (e.g. a cross-origin host without CORS headers makes the bytes
 * unreadable, so there is no client-side way to force a save). Throws only if
 * even the fallback fails.
 */
export async function downloadUrl(
  src: string,
  opts: { nameHint?: string; mime?: string } = {},
): Promise<"downloaded" | "opened"> {
  const filename = filenameFromUrl(opts.nameHint ?? src, opts.mime);
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await downloadBinaryFile(filename, bytes);
    return "downloaded";
  } catch {
    await openUrl(src);
    return "opened";
  }
}
