import { hasStrippableMetadata, isAnimatedImage, METADATA_SCAN_BYTES } from "@/lib/imageMetadata";

/** Maximum dimension (width or height) for resized images. */
const MAX_DIMENSION = 1920;

/** JPEG quality for resized images (0–1). */
const JPEG_QUALITY = 0.85;

interface ResizedImage {
  /** The optimized image file (JPEG or PNG, whichever is smaller). */
  file: File;
  /** Pixel dimensions string, e.g. "1920x1080". */
  dimensions: string;
}

/**
 * Prepare an image file for upload: cap its longest side at
 * {@link MAX_DIMENSION}, and strip embedded metadata.
 *
 * Both goals are met by drawing to a canvas and re-encoding, which discards
 * every ancillary chunk — EXIF (including GPS coordinates), XMP and IPTC.
 * Because that costs a generation of quality, it is skipped for images that
 * are already within the size limit *and* carry no metadata; those are
 * uploaded byte-for-byte.
 *
 * Animated images (GIF, APNG, animated WebP) are always passed through, since
 * a canvas round-trip would flatten them to a single frame.
 */
export async function resizeImage(file: File): Promise<ResizedImage> {
  const head = new Uint8Array(await file.slice(0, METADATA_SCAN_BYTES).arrayBuffer());

  // `imageOrientation: "from-image"` bakes any EXIF rotation into the pixels.
  // Without it, stripping the metadata would leave a sideways photo — the
  // orientation tag we just dropped was the only thing rotating it.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = bitmap;

  const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
  const animated = isAnimatedImage(file.type, head);

  if (animated || (!needsResize && !hasStrippableMetadata(head))) {
    bitmap.close();
    return { file, dimensions: `${width}x${height}` };
  }

  // Scale down preserving aspect ratio (a no-op when only stripping metadata).
  const scale = needsResize ? MAX_DIMENSION / Math.max(width, height) : 1;
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Canvas 2D context unavailable');
  }

  ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
  bitmap.close();

  // Encode as both JPEG and PNG in parallel, then pick the smaller one.
  const [jpegBlob, pngBlob] = await Promise.all([
    canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY),
    canvasToBlob(canvas, 'image/png'),
  ]);

  const best = jpegBlob.size <= pngBlob.size
    ? { blob: jpegBlob, ext: '.jpg', mime: 'image/jpeg' as const }
    : { blob: pngBlob, ext: '.png', mime: 'image/png' as const };

  const resizedFile = new File([best.blob], replaceExtension(file.name, best.ext), {
    type: best.mime,
  });

  return {
    file: resizedFile,
    dimensions: `${newWidth}x${newHeight}`,
  };
}

/** Promisified `canvas.toBlob`. */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`Failed to encode ${type}`))),
      type,
      quality,
    );
  });
}

/** Replace or append a file extension. */
function replaceExtension(filename: string, ext: string): string {
  const dotIndex = filename.lastIndexOf('.');
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return base + ext;
}
