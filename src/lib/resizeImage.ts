import { hasStrippableMetadata, isAnimatedImage, METADATA_SCAN_BYTES } from "@/lib/imageMetadata";

/** Maximum dimension (width or height) for resized images. */
const MAX_DIMENSION = 1920;

/** JPEG quality for resized images (0–1). */
const JPEG_QUALITY = 0.85;

interface ResizedImage {
  file: File;
  dimensions: string;
}

/**
 * Prepare an image for upload: cap the longest side at {@link MAX_DIMENSION}
 * and strip metadata (EXIF/GPS, XMP, IPTC) via canvas re-encode. Skipped for
 * in-bounds images without metadata and for animated images (canvas would flatten them).
 */
export async function resizeImage(file: File): Promise<ResizedImage> {
  const head = new Uint8Array(await file.slice(0, METADATA_SCAN_BYTES).arrayBuffer());

  const bitmap = await decodeUpright(file);
  const { width, height } = bitmap;

  const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
  const animated = isAnimatedImage(file.type, head);

  if (animated || (!needsResize && !hasStrippableMetadata(head))) {
    bitmap.close();
    return { file, dimensions: `${width}x${height}` };
  }

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

/**
 * Decode with EXIF rotation baked in, so dropping the orientation tag doesn't
 * leave photos sideways. Older Chromium WebViews reject `"from-image"` with a
 * TypeError; their default already applies the rotation.
 */
async function decodeUpright(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return createImageBitmap(file);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`Failed to encode ${type}`))),
      type,
      quality,
    );
  });
}

function replaceExtension(filename: string, ext: string): string {
  const dotIndex = filename.lastIndexOf('.');
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return base + ext;
}
