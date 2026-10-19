/** Free of the DOM so the push service worker can bundle it. */

interface PixelSource {
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
}

/**
 * Whether anything drawn into `context` is less than fully opaque — the
 * difference between an image JPEG can carry and one it would paint black.
 */
export function hasTransparency(context: PixelSource, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}
