/**
 * A notification icon as a small `data:` URL, for pictures that have no URL a
 * notification host could fetch (decrypted Concord icons). Free of the DOM so
 * the push service worker can bundle it.
 */

import { bytesToBase64, sniffImageMime } from "@/lib/fileBytes";

/** Longest edge drawn; a notification shows a face at well under this. */
export const NOTIFICATION_ICON_EDGE = 256;

/**
 * Ceiling on the URL. Tenna drops a `data:` picture over 64 KiB, and on the
 * page path the title and body share that budget.
 */
export const MAX_NOTIFICATION_ICON_CHARS = 48 * 1024;

/** Kept as PNG (transparency) up to here; past it, a photo is far smaller as JPEG. */
const PNG_PREFERRED_BYTES = 16 * 1024;

const JPEG_QUALITIES = [0.85, 0.6];

function canRedraw(): boolean {
  return typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
}

async function dataUrl(blob: Blob): Promise<string> {
  return `data:${blob.type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}

/**
 * `bytes` redrawn no larger than `edge` as a `data:` URL within
 * {@link MAX_NOTIFICATION_ICON_CHARS}, or undefined if it can't be made to fit.
 * Without OffscreenCanvas, small enough originals pass through unchanged.
 */
export async function notificationIconDataUrl(
  bytes: Uint8Array,
  mime: string,
  edge: number = NOTIFICATION_ICON_EDGE,
): Promise<string | undefined> {
  if (!mime.startsWith("image/") || mime === "image/svg+xml") return undefined;
  const original = new Blob([new Uint8Array(bytes)], { type: mime });

  if (!canRedraw()) {
    const url = await dataUrl(original);
    return url.length <= MAX_NOTIFICATION_ICON_CHARS ? url : undefined;
  }

  try {
    const bitmap = await createImageBitmap(original);
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const png = await canvas.convertToBlob({ type: "image/png" });
    if (png.size <= PNG_PREFERRED_BYTES) return await dataUrl(png);
    for (const quality of JPEG_QUALITIES) {
      const url = await dataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality }));
      if (url.length <= MAX_NOTIFICATION_ICON_CHARS) return url;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** A media-policy URL as a notification icon `data:` URL; undefined if unfetchable (CORS) or too big. */
export async function fetchNotificationIcon(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = sniffImageMime(bytes) ?? res.headers.get("content-type") ?? "";
    return await notificationIconDataUrl(bytes, mime);
  } catch {
    return undefined;
  }
}
