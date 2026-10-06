/**
 * The images Armada's link previews draw, on an `OffscreenCanvas` — in
 * npanel's sandbox, whose text is the gateway's fonts, or in a browser alike.
 * Both are 1200×630 on Armada's own sea, with the mark from `public/logo.svg`.
 */

import logoSvg from "../../public/logo.svg?raw";

import { drawEmojiMask } from "@/lib/avatarShape";

const WIDTH = 1200;
const HEIGHT = 630;

const SEA = "#100b15";
const SAND = "#f1e7d2";
const ROSE = "#fb4d96";
const CYAN = "#19e6e6";
// The card's JetBrains Mono, else the DejaVu npanel's image installs.
const MONO = `"JetBrains Mono", "DejaVu Sans Mono", monospace`;

/** A profile: the avatar, cut to its shape, as the mark's sail over its waves. */
export async function drawProfile(picture: string | undefined, shape: string | undefined, name: string): Promise<Blob> {
  const { canvas, ctx } = sea();
  const waterline = 520;

  // The sail alone, faint and filling the height behind the avatar, its foot
  // on the waves drawn below it. Its base is at 92.7 of the logo's 128.
  const markSize = 700;
  const sail = await loadSvg(logoSvg.replace(/<g fill="#19e6e6">[\s\S]*?<\/g>/, ""), markSize);
  if (sail) {
    ctx.globalAlpha = 0.12;
    ctx.drawImage(sail, (WIDTH - markSize) / 2, waterline - 8 - (92.7 / 128) * markSize);
    ctx.globalAlpha = 1;
  }

  const size = 340;
  const avatar = new OffscreenCanvas(size, size);
  const actx = avatar.getContext("2d")!;
  const bitmap = picture ? await loadImage(picture) : null;
  if (bitmap) {
    drawCover(actx, bitmap, size, size);
  } else {
    // A monogram, as the app shows someone without a picture.
    actx.fillStyle = "#2a2133";
    actx.fillRect(0, 0, size, size);
    actx.fillStyle = SAND;
    actx.font = `bold 160px ${MONO}`;
    actx.textAlign = "center";
    actx.textBaseline = "middle";
    actx.fillText([...name.trim()][0]?.toUpperCase() ?? "?", size / 2, size / 2 + 8);
  }

  const mask = shape ? drawEmojiMask(shape, (w, h) => new OffscreenCanvas(w, h), size) : null;
  actx.globalCompositeOperation = "destination-in";
  if (mask) {
    actx.drawImage(mask, 0, 0);
  } else {
    actx.beginPath();
    actx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    actx.fill();
  }

  const x = (WIDTH - size) / 2;
  const y = 110;
  if (!mask) {
    // A rose ring, set off from the avatar by a band of sea.
    ctx.fillStyle = ROSE;
    ctx.beginPath();
    ctx.arc(WIDTH / 2, y + size / 2, size / 2 + 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SEA;
    ctx.beginPath();
    ctx.arc(WIDTH / 2, y + size / 2, size / 2 + 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.drawImage(avatar, x, y);

  waves(ctx, WIDTH / 2, waterline, 1.6);
  await lockup(ctx);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

/** An invite: the mark beside an invitation, as `public/og.svg` lays out the card. */
export async function drawInvite(): Promise<Blob> {
  const { canvas, ctx } = sea();

  const mark = await loadSvg(logoSvg, 256);
  if (mark) ctx.drawImage(mark, 112, 179);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SAND;
  ctx.font = `bold 84px ${MONO}`;
  ctx.fillText("you're invited", 400, 290);

  ctx.font = `26px ${MONO}`;
  ctx.fillStyle = CYAN;
  ctx.fillText("$", 402, 352);
  ctx.fillStyle = ROSE;
  // A trailing space measures as nothing; the font is monospaced.
  ctx.fillText("join an encrypted community", 402 + ctx.measureText("$").width * 2, 352);

  ctx.globalAlpha = 0.55;
  ctx.fillStyle = SAND;
  const line = "on armada. open the link to see where.";
  ctx.fillText(line, 402, 392);
  ctx.globalAlpha = 1;
  ctx.fillStyle = ROSE;
  ctx.fillText("_", 402 + ctx.measureText(line).width, 392);

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

/** The mark and wordmark, small, in the bottom-right corner. */
async function lockup(ctx: OffscreenCanvasRenderingContext2D): Promise<void> {
  const mark = await loadSvg(logoSvg, 44);
  ctx.font = `bold 30px ${MONO}`;
  ctx.textBaseline = "middle";
  const right = WIDTH - 40;
  const width = ctx.measureText("armada").width;
  if (mark) ctx.drawImage(mark, right - width - 52, HEIGHT - 40 - 44);
  ctx.fillStyle = SAND;
  ctx.fillText("armada", right - width, HEIGHT - 40 - 22);
}

function sea(): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = SEA;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  return { canvas, ctx };
}

/** The mark's three tapering wave lines, centred on `cx`. */
function waves(ctx: OffscreenCanvasRenderingContext2D, cx: number, top: number, scale: number): void {
  ctx.fillStyle = CYAN;
  // [width, height, top] of each line in logo.svg's units.
  for (const [w, h, y] of [[67.08, 4.28, 0], [42.83, 2.86, 12.12], [22.12, 2.14, 21.05]]) {
    ctx.beginPath();
    ctx.roundRect(cx - (w * scale) / 2, top + y * scale, w * scale, h * scale, (h * scale) / 2);
    ctx.fill();
  }
}

async function loadSvg(svg: string, size: number): Promise<ImageBitmap | null> {
  const sized = svg.replace(/width="128" height="128"/, `width="${size}" height="${size}"`);
  try {
    return await createImageBitmap(new Blob([sized], { type: "image/svg+xml" }));
  } catch {
    return null;
  }
}

async function loadImage(url: string): Promise<ImageBitmap | null> {
  if (!url.startsWith("https://")) return null;
  try {
    const response = await fetch(url);
    return response.ok ? await createImageBitmap(await response.blob()) : null;
  } catch {
    return null;
  }
}

/** Draw an image to fill a box from its origin, cropping what overflows, centred. */
function drawCover(ctx: OffscreenCanvasRenderingContext2D, image: ImageBitmap, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, 0, 0, w, h);
}
