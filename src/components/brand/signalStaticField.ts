/**
 * The noise field behind {@link SignalStatic}. Baked once into a sprite of
 * {@link FRAMES} frames played by a compositor `steps()` animation, so it keeps
 * moving while sync work blocks JS (a rAF loop would freeze).
 */

/** Intended playback rate; the sprite loop's duration is FRAMES / FPS. */
export const FPS = 12;
/** CSS pixels per noise cell — fine CRT grain, not chunky blocks. */
export const CELL = 5;
export const FRAMES = 24;
/** Advances run before the first painted frame, settling the phosphor. */
export const WARMUP_FRAMES = 4;
/** Per-frame alpha retention: a speck survives ~4 frames (phosphor persistence). */
const DECAY = 0.72;
const DENSITY = 0.16;
/** Speck tints: cyan snow with a scatter of rose. */
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

  private rnd(): number {
    let r = this.rng;
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    this.rng = r;
    return (r >>> 0) / 4294967296;
  }

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

  advance(): void {
    const img = this.img;
    if (!img) return;
    // Scaled by (1 - DECAY) so steady-state coverage matches DENSITY.
    const spawn = DENSITY * (1 - DECAY);
    const data = img.data;
    for (let i = 0; i < this.iw * this.ih; i++) {
      const p = i * 4;
      // The -1 lets decay reach zero despite Uint8 rounding. One draw per cell: `r`
      // decides lit-or-not and, rescaled, brightness.
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

  paint(ctx: CanvasRenderingContext2D, dy: number): void {
    if (this.img) ctx.putImageData(this.img, 0, dy);
  }
}
