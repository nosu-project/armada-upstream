import type React from 'react';

/** Kind-0 `shape`: an emoji used as a mask. Absent/invalid renders a circle. */
export type AvatarShape = string;

/**
 * Whether a value could be an emoji shape: a short non-ASCII string (matching
 * Unicode emoji patterns is fragile for keycaps, flags, ZWJ families).
 */
export function isEmoji(value: string): boolean {
  if (!value || value.length === 0) return false;
  if (value.length > 20) return false;
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(value);
}

/** Type guard for valid avatar shape values. */
export function isValidAvatarShape(value: unknown): value is AvatarShape {
  if (typeof value !== 'string' || value.length === 0) return false;

  return isEmoji(value);
}

/** A valid AvatarShape from metadata, or `undefined` (circle). */
export function getAvatarShape(metadata: { [key: string]: unknown } | undefined): AvatarShape | undefined {
  const raw = metadata?.shape;
  return isValidAvatarShape(raw) ? raw : undefined;
}

/** Solid outline for shaped avatars; apply to a wrapper around the masked `<Avatar>`. */
export const shapedAvatarBorderStyle: React.CSSProperties = {
  filter:
    'drop-shadow(3px 0 0 hsl(var(--background)))' +
    ' drop-shadow(-3px 0 0 hsl(var(--background)))' +
    ' drop-shadow(0 3px 0 hsl(var(--background)))' +
    ' drop-shadow(0 -3px 0 hsl(var(--background)))',
};

/**
 * Snug green "speaking" outline for shaped avatars. Must wrap the masked
 * `<Avatar>`: a ring on the masked element would be clipped away.
 */
export const shapedAvatarSpeakingStyle: React.CSSProperties = {
  filter:
    'drop-shadow(1px 0 0 hsl(var(--success)))' +
    ' drop-shadow(-1px 0 0 hsl(var(--success)))' +
    ' drop-shadow(0 1px 0 hsl(var(--success)))' +
    ' drop-shadow(0 -1px 0 hsl(var(--success)))' +
    ' drop-shadow(1px 1px 0 hsl(var(--success)))' +
    ' drop-shadow(1px -1px 0 hsl(var(--success)))' +
    ' drop-shadow(-1px 1px 0 hsl(var(--success)))' +
    ' drop-shadow(-1px -1px 0 hsl(var(--success)))',
};

/** LRU: each entry is a 256px PNG data URL, and few shapes are on screen at once. */
const emojiMaskCache = new Map<string, string>();
const EMOJI_MASK_CACHE_MAX = 64;

/** Mask URL for emoji avatar shapes, or '' if invalid or generation fails. */
export function getAvatarMaskUrl(shape: string): string {
  if (isEmoji(shape)) {
    return getEmojiMaskUrl(shape);
  }

  return '';
}

/** Async version of getAvatarMaskUrl. */
export async function getAvatarMaskUrlAsync(shape: string): Promise<string> {
  if (isEmoji(shape)) {
    return getEmojiMaskUrl(shape);
  }

  return '';
}

/**
 * Render the native OS emoji to a canvas and produce a PNG alpha mask for CSS
 * `mask-image`: draw oversized, crop to the tight alpha bounding box squared
 * (so non-square emoji aren't stretched), redraw at 256px, whiten RGB.
 */
export function getEmojiMaskUrl(emoji: string): string {
  // Failures are cached too; re-rendering an undrawable emoji per render was
  // the largest scroll cost on phones.
  const cached = emojiMaskCache.get(emoji);
  if (cached !== undefined) {
    emojiMaskCache.delete(emoji);
    emojiMaskCache.set(emoji, cached);
    return cached;
  }
  const url = renderEmojiMask(emoji);
  emojiMaskCache.set(emoji, url);
  if (emojiMaskCache.size > EMOJI_MASK_CACHE_MAX) {
    emojiMaskCache.delete(emojiMaskCache.keys().next().value as string);
  }
  return url;
}

function renderEmojiMask(emoji: string): string {
  const mask = drawEmojiMask(emoji, (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  });
  return mask ? mask.toDataURL('image/png') : '';
}

type MaskCanvas = HTMLCanvasElement | OffscreenCanvas;
type MaskContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * The mask itself, on canvases from `createCanvas` — an `OffscreenCanvas`
 * works too, which is how the npanel link-preview script (`src/npanel/`) cuts
 * avatars the same way. `null` when the glyph draws nothing.
 */
export function drawEmojiMask<C extends MaskCanvas>(
  emoji: string,
  createCanvas: (width: number, height: number) => C,
  out = 256,
): C | null {
  // The bounding-box scan is quadratic in size; 256px is enough for the mask.
  const fontSize = 256;
  const scratch = fontSize * 1.5;               // 384 – generous room
  const c1 = createCanvas(scratch, scratch);
  const ctx1 = c1.getContext('2d', { willReadFrequently: true }) as MaskContext | null;
  if (!ctx1) return null;

  ctx1.textAlign = 'center';
  ctx1.textBaseline = 'middle';
  ctx1.font = `${fontSize}px serif`;
  ctx1.fillText(emoji, scratch / 2, scratch / 2);

  // Alpha threshold ignores shadows/glows/AA fringes that would push the crop off-centre.
  const ALPHA_THRESHOLD = 25;                    // ~10% opacity
  const { data: px, width: sw, height: sh } = ctx1.getImageData(0, 0, scratch, scratch);
  let t = sh, b = 0, l = sw, r = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (px[(y * sw + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (y < t) t = y;
        if (y > b) b = y;
        if (x < l) l = x;
        if (x > r) r = x;
      }
    }
  }
  if (r < l || b < t) return null;               // nothing drawn

  let cropW = r - l + 1;
  let cropH = b - t + 1;
  if (cropW > cropH) {
    const diff = cropW - cropH;
    t -= Math.floor(diff / 2);
    b = t + cropW - 1;
    cropH = cropW;
  } else if (cropH > cropW) {
    const diff = cropH - cropW;
    l -= Math.floor(diff / 2);
    r = l + cropH - 1;
    cropW = cropH;
  }
  if (t < 0) t = 0;
  if (l < 0) l = 0;

  const c2 = createCanvas(out, out);
  const ctx2 = c2.getContext('2d') as MaskContext | null;
  if (!ctx2) return null;

  ctx2.drawImage(c1, l, t, cropW, cropH, 0, 0, out, out);

  const img = ctx2.getImageData(0, 0, out, out);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
  }
  ctx2.putImageData(img, 0, 0);

  return c2;
}
