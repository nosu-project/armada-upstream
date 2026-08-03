/**
 * Cross-platform share + clipboard.
 *
 * On the native APK these route through Capacitor's plugins (the Android System
 * WebView often doesn't expose the Web Share API, so `navigator.share` is
 * unavailable and sharing silently falls back to a copy). On the web we use the
 * Web Share / Clipboard APIs when present.
 */

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";

import { bytesToBase64, filenameFromUrl, sniffImageMime } from "@/lib/fileBytes";

const native = Capacitor.isNativePlatform();

/** True when the native share sheet / Web Share API can be used. */
export function canShare(): boolean {
  if (native) return true;
  return typeof navigator !== "undefined" && "share" in navigator;
}

/**
 * True when the share sheet can carry a FILE, not just a link. Narrower than
 * {@link canShare}: Web Share Level 2 is missing on desktop Firefox and older
 * Safari, so the caller must be able to hide the affordance rather than offer
 * one that does nothing.
 */
export function canShareFiles(): boolean {
  if (native) return true;
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files: [new File([], "probe.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

/**
 * Open the native share sheet (or Web Share API). Resolves true if the share
 * was presented, false if it couldn't be (so callers can fall back to copy).
 * A user-cancelled share still counts as presented.
 */
export async function share(opts: {
  title?: string;
  text?: string;
  url?: string;
  dialogTitle?: string;
}): Promise<boolean> {
  if (native) {
    try {
      await Share.share({
        title: opts.title,
        text: opts.text,
        url: opts.url,
        dialogTitle: opts.dialogTitle ?? opts.title,
      });
    } catch {
      // Cancelled, or failed after the sheet was up — the plugin doesn't
      // distinguish them, and falling back to a copy on a cancel would be
      // worse than doing nothing.
    }
    return true;
  }
  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      await navigator.share({ title: opts.title, text: opts.text, url: opts.url });
      return true;
    } catch (e) {
      // AbortError is the user closing a sheet that DID open. Anything else —
      // NotAllowedError when an await upstream consumed the click's transient
      // activation, TypeError on bad data — means no sheet was ever shown, so
      // report false and let the caller fall back to copy instead of nothing.
      return (e as Error | null)?.name === "AbortError";
    }
  }
  return false;
}

/**
 * Share the CONTENTS of a media `src` — the file itself, not a link to it.
 *
 * A link is the wrong thing to hand over for most attachments here: an
 * encrypted one's `url` names ciphertext on a Blossom host and the decryption
 * key never leaves the client, so the recipient gets bytes they can't read; and
 * a `blob:` src has no meaning outside this document at all. The bytes are
 * already local by the time a lightbox can offer this, so sending them is both
 * correct and cheap.
 *
 * Native writes a transient copy to the cache directory and hands the system
 * sheet its file URI — Capacitor's Share plugin takes paths, not blobs. Web
 * uses `navigator.share({ files })`.
 *
 * Resolves false when no file-capable sheet exists or the bytes couldn't be
 * read, so callers can fall back instead of silently doing nothing. A
 * user-cancelled share counts as presented (true), matching {@link share}.
 */
export async function shareFile(
  src: string,
  opts: { nameHint?: string; mime?: string; title?: string; text?: string; dialogTitle?: string } = {},
): Promise<boolean> {
  let bytes: Uint8Array;
  let mime = opts.mime;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    // Type and extension are what make the sheet render a thumbnail instead of
    // a blank document, and both are frequently missing upstream — so fall
    // back to the transport's claim, then to the bytes themselves.
    const declared = res.headers.get("content-type")?.split(";")[0].trim();
    mime = mime || (declared && declared !== "application/octet-stream" ? declared : undefined) ||
      sniffImageMime(bytes);
  } catch {
    return false;
  }
  const filename = filenameFromUrl(opts.nameHint ?? src, mime);

  if (native) {
    let uri: string;
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      // Cache, not Documents: this copy exists only to feed the share sheet and
      // the OS may reclaim it. Keeping a copy is what the download button does.
      ({ uri } = await Filesystem.writeFile({
        path: filename,
        data: bytesToBase64(bytes),
        directory: Directory.Cache,
      }));
    } catch {
      return false;
    }
    try {
      await Share.share({
        title: opts.title,
        text: opts.text,
        files: [uri],
        dialogTitle: opts.dialogTitle ?? opts.title,
      });
    } catch {
      // Cancelled, or failed after the sheet was up — indistinguishable, and
      // falling back to a download on a cancel would be worse than doing nothing.
    }
    return true;
  }

  const file = new File([bytes as BlobPart], filename, { type: mime || "application/octet-stream" });
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: opts.title, text: opts.text });
    return true;
  } catch (e) {
    // Same distinction as `share`: AbortError = cancelled a sheet that opened;
    // anything else = no sheet, so the caller should offer its fallback.
    return (e as Error | null)?.name === "AbortError";
  }
}

/**
 * Open an external URL. On native, use the share sheet (the WebView's
 * `window.open` doesn't always hand off to the system browser); on web,
 * open in a new tab.
 */
export async function openUrl(url: string): Promise<void> {
  if (native) {
    await Share.share({ url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
