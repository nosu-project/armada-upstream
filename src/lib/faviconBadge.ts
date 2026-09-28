/**
 * Renders the document's own favicon with an unread dot. PNG rather than SVG
 * because Safari doesn't read SVG favicons. Not unit-tested: jsdom has no canvas.
 */

/** Red rather than primary: the logo's sail is primary pink, so a pink dot would read as part of it. */
const DOT_COLOR = "#ff3b30";

const CANVAS_SIZE = 64;

const DOT_RADIUS = CANVAS_SIZE * 0.2;
const DOT_INSET = CANVAS_SIZE * 0.02;
/** Dot is separated by a transparent hole, not a colored ring, so it reads on light and dark tab strips. */
const DOT_RING = CANVAS_SIZE * 0.07;

/** A load that never settles would otherwise block retries for the life of the page. */
const LOAD_TIMEOUT_MS = 10_000;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error(`favicon load timed out: ${src}`)), LOAD_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error(`favicon load failed: ${src}`)); };
    img.src = src;
  });
}

/**
 * The badged icon as a PNG data URL, or `null` if the platform can't produce
 * one (no 2D context, tainted canvas). A failed icon load rejects instead: transient.
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

  // Top-right, clear of the sail and wave.
  const cx = CANVAS_SIZE - DOT_RADIUS - DOT_INSET;
  const cy = DOT_RADIUS + DOT_INSET;

  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, DOT_RADIUS + DOT_RING, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = DOT_COLOR;
  ctx.beginPath();
  ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  try {
    return canvas.toDataURL("image/png");
  } catch {
    // A cross-origin favicon taints the canvas; don't let the SecurityError kill the notifier.
    return null;
  }
}
