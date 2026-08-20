/**
 * Renders the app's own favicon with an unread dot burnt into it.
 *
 * The source is whatever `<link rel="icon">` the document already carries, so
 * the badge follows the real mark rather than a second copy of the artwork
 * kept in sync by hand. It is rasterized once per page load (the result is a
 * `data:` URL the caller caches) at a size browsers can downscale to any tab
 * chrome, and it is a PNG rather than an SVG because Safari does not read SVG
 * favicons at all — an SVG wrapper would silently badge nothing there.
 *
 * Not unit-tested directly: jsdom has no canvas, and a `canvas`-package stub
 * would be testing that stub. `tabAttention.test.ts` mocks this module, which
 * is where the behavior that matters (which link the browser ends up seeing)
 * lives.
 */

/** The dot's fill — `bg-primary`, matching every unread badge in the app. */
const DOT_COLOR = "#fb4d96";

/**
 * Rasterization size. Larger than any tab favicon so a downscale stays sharp,
 * small enough that the data URL is a couple of KB.
 */
const CANVAS_SIZE = 64;

const DOT_RADIUS = CANVAS_SIZE * 0.24;
const DOT_INSET = CANVAS_SIZE * 0.05;
/**
 * The dot is separated from the mark by a hole punched through the icon rather
 * than by a ring drawn in a colour, because the tab strip behind it is white on
 * one browser/theme and near-black on the next; transparency reads on both.
 */
const DOT_RING = CANVAS_SIZE * 0.07;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`favicon load failed: ${src}`));
    img.src = src;
  });
}

/**
 * The badged icon as a PNG `data:` URL, or `null` when it can't be produced
 * (no 2D context, an icon that won't load, a tainted canvas). Callers treat
 * `null` as "this platform gets no tab badge" — never as a reason to fall back
 * to decorating the document title.
 */
export async function renderBadgedFavicon(baseHref: string): Promise<string | null> {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const img = await loadImage(baseHref);
  ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const center = CANVAS_SIZE - DOT_RADIUS - DOT_INSET;

  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(center, center, DOT_RADIUS + DOT_RING, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = DOT_COLOR;
  ctx.beginPath();
  ctx.arc(center, center, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  try {
    return canvas.toDataURL("image/png");
  } catch {
    // Same-origin icons don't taint the canvas, but a deployment that points
    // its favicon elsewhere would — and a SecurityError here must not take the
    // notifier down with it.
    return null;
  }
}
