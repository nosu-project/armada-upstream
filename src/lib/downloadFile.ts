import { Capacitor } from "@capacitor/core";

import { bytesToBase64, filenameFromUrl, safeFilename } from "@/lib/fileBytes";
import { openUrl } from "@/lib/share";

/**
 * Save raw bytes to the device: `<a download>` on web; on native (where that
 * silently fails) a base64 write to Documents (iOS Files / Android shared
 * `DIRECTORY_DOCUMENTS`), no permission needed.
 *
 * `filename` is sanitized here because neither native plugin contains paths
 * (`..` resolves). Sanitized, not rejected: {@link downloadUrl} answers a throw
 * by opening the URL.
 */
export async function downloadBinaryFile(filename: string, bytes: Uint8Array): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    // No `encoding` → Capacitor treats `data` as base64.
    await Filesystem.writeFile({
      path: safeFilename(filename),
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
 * Save a media `src` (resolved: a decrypted `blob:` URL or plain `https:`) by
 * fetching its bytes; `nameHint` only derives the filename. Returns
 * `'opened'` when it had to fall back to opening (e.g. CORS-less host).
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
