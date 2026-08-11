/**
 * The noise field behind {@link SignalStatic} — generation-time logic only.
 *
 * The component renders {@link FRAMES} consecutive frames of this field into
 * one tall sprite canvas at mount, and a compositor-driven `steps()` transform
 * animation plays them back on a loop forever. After that one-time render the
 * flicker costs the main thread nothing — and, more to the point, it keeps
 * moving while the sync's own decrypt/store bursts block JS, exactly the
 * stalls that made a live rAF loop freeze and read as a lock-up.
 *
 * The playback loop wraps from the last frame to the first, whose phosphor
 * trails don't continue each other; at these speck alphas the seam is
 * imperceptible, and {@link WARMUP_FRAMES} keeps the first frame from being
 * visibly sparser than the rest.
 */

/** Intended playback rate; the sprite loop's duration is FRAMES / FPS. */
export const FPS = 12;
/** CSS pixels per noise cell — fine CRT grain, not chunky blocks. */
export const CELL = 5;
/** Frames baked into the sprite. More frames = a less noticeable loop. */
export const FRAMES = 24;
/** Advances run before the first painted frame, settling the phosphor. */
export const WARMUP_FRAMES = 4;
/**
 * Per-frame alpha retention. A lit speck survives ~4 frames, fading — the
 * phosphor persistence that keeps the field from strobing.
 */
const DECAY = 0.72;
/** Fraction of cells lit at steady state. */
const DENSITY = 0.16;
/**
 * Speck tints — the brand's own wire cyan and rose: ambient snow is cyan
 * with a scatter of rose. (Interference bands are not baked into the sprite;
 * they're the component's DOM flash, fired by real wire impulses.)
 */
const CYAN = [110, 225, 235] as const;
const ROSE = [240, 95, 170] as const;

/** FNV-1a, folding a seed string into a 32-bit PRNG state. */
export function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  return h >>> 0 || 1;
}

export class SignalStaticField {
  private rng: number;
  private img: ImageData | null = null;
  private iw = 0;
  private ih = 0;

  constructor(seed: number) {
    this.rng = seed >>> 0 || 1;
  }

  /** xorshift32 over the seed-derived state. */
  private rnd(): number {
    let r = this.rng;
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    this.rng = r;
    return (r >>> 0) / 4294967296;
  }

  /** (Re)build the cell buffer for a grid of w×h cells. */
  resize(w: number, h: number): void {
    this.iw = w;
    this.ih = h;
    this.img = new ImageData(w, h);
    // Prefill the cyan base; strikes rewrite RGB only when they re-tint.
    const data = this.img.data;
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = CYAN[0];
      data[i * 4 + 1] = CYAN[1];
      data[i * 4 + 2] = CYAN[2];
    }
  }

  /** Advance the field one frame: decay what's lit, strike fresh specks. */
  advance(): void {
    const img = this.img;
    if (!img) return;
    // Spawn rate scaled by (1 - DECAY): steady-state coverage then matches
    // DENSITY even though every speck persists while it fades.
    const spawn = DENSITY * (1 - DECAY);
    const data = img.data;
    for (let i = 0; i < this.iw * this.ih; i++) {
      const p = i * 4;
      // Fade what's lit (the -1 lets the decay reach true zero despite Uint8
      // rounding), then maybe strike a fresh speck. One draw per cell: `r`
      // decides lit-or-not AND, rescaled, how bright.
      let a = data[p + 3] * DECAY - 1;
      const r = this.rnd();
      if (r < spawn) {
        const struck = (35 + 130 * (r / spawn)) * 0.65;
        if (struck > a) {
          a = struck;
          const rose = (r * 31) % 1 < 0.15;
          data[p] = rose ? ROSE[0] : CYAN[0];
          data[p + 1] = rose ? ROSE[1] : CYAN[1];
          data[p + 2] = rose ? ROSE[2] : CYAN[2];
        }
      }
      data[p + 3] = a;
    }
  }

  /** Paint the current frame into the sprite at row offset `dy`. */
  paint(ctx: CanvasRenderingContext2D, dy: number): void {
    if (this.img) ctx.putImageData(this.img, 0, dy);
  }
}
