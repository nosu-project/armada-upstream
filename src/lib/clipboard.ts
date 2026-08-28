import { Capacitor } from "@capacitor/core";
import { Clipboard } from "@capacitor/clipboard";

/**
 * Read text from the system clipboard, working on both the web build and the
 * Capacitor (Android) build.
 *
 * `navigator.clipboard.readText()` is unimplemented in Android's system WebView,
 * so on native we go through the `@capacitor/clipboard` plugin instead; on the
 * web we use the standard async Clipboard API. Throws if the clipboard can't be
 * read (e.g. permission denied, or no clipboard at all) so callers can surface
 * a "paste failed, try manually" message.
 */
export async function readClipboardText(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const result = await Clipboard.read();
    return result.value ?? "";
  }
  if (!navigator.clipboard?.readText) {
    throw new Error("Clipboard read is not available.");
  }
  return await navigator.clipboard.readText();
}

/**
 * Write text to the system clipboard, working on both the web build and the
 * Capacitor (Android) build. Uses the `@capacitor/clipboard` plugin on native
 * (the WebView's `navigator.clipboard.writeText` is unreliable there) and the
 * standard async Clipboard API on the web. Throws if the write fails.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Clipboard.write({ string: text });
    return;
  }
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard write is not available.");
  }
  await navigator.clipboard.writeText(text);
}

/**
 * True where an image can be copied to the clipboard AS an image (not as a
 * link or a data-URL string), so a caller can hide the affordance instead of
 * offering one that does nothing or copies gibberish.
 *
 * - **iOS** goes through the Capacitor plugin, which sets `UIPasteboard.image`
 *   — a real image copy.
 * - **Android** is excluded: the same plugin's "image" branch only does
 *   `ClipData.newPlainText`, so it would copy the raw `data:` URL as TEXT, not
 *   an image. The Save/Share actions already cover Android.
 * - **Web / desktop** needs the async Clipboard API's `ClipboardItem`, absent
 *   on Firefox before it shipped `clipboard.write`.
 */
export function canCopyImages(): boolean {
  if (Capacitor.getPlatform() === "ios") return true;
  if (Capacitor.isNativePlatform()) return false;
  return typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
}

/**
 * Copy the CONTENTS of an image `src` to the clipboard as an image.
 *
 * The bytes are already local by the time this can be offered (a decrypted
 * `blob:` src, or a fetched `https:` one), mirroring {@link shareFile}. On the
 * web browsers only reliably accept `image/png` on the clipboard, so anything
 * else is decoded and re-encoded to PNG; the resulting Blob is handed to
 * `ClipboardItem` as a PROMISE so Safari keeps the click's transient
 * activation across the fetch/convert (Chromium accepts it either way). On iOS
 * the plugin takes a data URL and pastes a real image. Throws if the copy
 * can't be done so callers can surface a failure.
 */
export async function writeClipboardImage(src: string): Promise<void> {
  if (Capacitor.getPlatform() === "ios") {
    const blob = await fetchImageBlob(src);
    await Clipboard.write({ image: await blobToDataUrl(blob) });
    return;
  }
  if (Capacitor.isNativePlatform()) {
    throw new Error("Copying an image isn't available on this platform.");
  }
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Copying an image isn't available.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": fetchImageAsPng(src) })]);
}

/** Fetch a media `src` (blob: or https:) into a Blob. */
async function fetchImageBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  return await res.blob();
}

/** Fetch a media `src` and normalize it to a PNG Blob for the web clipboard. */
async function fetchImageAsPng(src: string): Promise<Blob> {
  const blob = await fetchImageBlob(src);
  if (blob.type === "image/png") return blob;
  return await encodeBlobToPng(blob);
}

/** Decode an image Blob and re-encode it as PNG via an offscreen canvas. */
async function encodeBlobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get a 2D canvas context.");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error("Could not encode the image as PNG."))),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}

/** Read a Blob as a `data:` URL (for the native clipboard plugin). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(blob);
  });
}
