import { Capacitor } from "@capacitor/core";
import { Clipboard } from "@capacitor/clipboard";

/**
 * Read clipboard text. Android WebView lacks `navigator.clipboard.readText()`,
 * so native uses `@capacitor/clipboard`. Throws if unreadable.
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

/** Write clipboard text (Capacitor plugin on native, where WebView writeText is unreliable). */
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
 * Whether an image can be copied AS an image. iOS: the plugin sets
 * `UIPasteboard.image`. Android: excluded — the plugin copies the `data:` URL as
 * text. Web: needs `ClipboardItem`.
 */
export function canCopyImages(): boolean {
  if (Capacitor.getPlatform() === "ios") return true;
  if (Capacitor.isNativePlatform()) return false;
  return typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
}

/**
 * Copy an image `src`'s contents to the clipboard. Web only reliably accepts
 * PNG, so others are re-encoded; the Blob is passed to `ClipboardItem` as a
 * PROMISE so Safari keeps the click's transient activation.
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
