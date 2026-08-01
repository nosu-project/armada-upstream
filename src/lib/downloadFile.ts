import { Capacitor } from "@capacitor/core";

import { bytesToBase64, filenameFromUrl } from "@/lib/fileBytes";
import { openUrl } from "@/lib/share";

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
