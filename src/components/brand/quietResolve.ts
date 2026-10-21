/**
 * "Quiet Resolve", the wreck page's theme: a port of the score and the NES-style
 * renderer it was written with (gameover3 `src/score.py`, `src/render.py`), so
 * the loop is synthesized here instead of shipped as audio. F minor, 3/4, 115
 * BPM, exactly 32 bars. Voices are generated hard-edged at 4× the output rate,
 * then decimated, which keeps square edges crunchy without aliasing fizz.
 */

export const SAMPLE_RATE = 44100;
const OS = 4;
const FS = SAMPLE_RATE * OS;

const BPM = 115;
const EIGHTH = 60 / BPM / 2;
const BAR = 6;
const BARS = 32;

type Chord = "Fm" | "Db" | "Bbm" | "C" | "Eb" | "Ab";

const LOOP_A: Chord[] = ["Fm", "Db", "Bbm", "C"];
const LOOP_B: Chord[] = ["Db", "Eb", "Ab", "C"];
const CHORDS: Chord[] = [...LOOP_A, ...LOOP_A, ...LOOP_A, ...LOOP_A, ...LOOP_B, ...LOOP_B, ...LOOP_B, ...LOOP_B];

const PITCH: Record<string, number> = {
  C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11,
};

const CHORD_TONES: Record<Chord, [string, string, string]> = {
  Fm: ["F", "Ab", "C"], Db: ["Db", "F", "Ab"], Bbm: ["Bb", "Db", "F"],
  C: ["C", "E", "G"], Eb: ["Eb", "G", "Bb"], Ab: ["Ab", "C", "Eb"],
};

/** Walking bass for the fall: root, then a step toward the next chord. */
const WALK_A: Partial<Record<Chord, string>> = { Fm: "Eb", Db: "C", Bbm: "Db", C: "G" };

type Bar = [string, number][];

const FALL: Bar = [["C6", 2], ["Ab5", 1], ["G5", 1], ["F5", 1], ["G5", 1]];
/** Durations in eighths; a trailing `~` scoops up from a semitone below. */
const MELODY: Bar[] = [
  FALL, [["Ab5", 4], ["F5", 2]],
  [["Db6", 2], ["C6", 1], ["Bb5", 1], ["Ab5", 1], ["Bb5", 1]], [["G5~", 6]],
  FALL, [["Ab5", 2], ["Bb5", 2], ["C6", 2]],
  [["Db6", 2], ["F6", 2], ["Eb6", 1], ["Db6", 1]], [["C6~", 6]],
  FALL, [["Ab5", 4], ["F5", 2]],
  [["Db6", 2], ["C6", 1], ["Bb5", 1], ["Ab5", 1], ["Bb5", 1]], [["G5~", 4], ["Ab5", 1], ["Bb5", 1]],
  FALL, [["Ab5", 2], ["Bb5", 2], ["C6", 2]],
  [["Db6", 2], ["F6", 2], ["Eb6", 1], ["Db6", 1]], [["C6~", 4], ["E5", 1], ["F5", 1]],
  [["Ab5", 4], ["F5", 1], ["Ab5", 1]], [["Bb5", 4], ["G5", 1], ["Bb5", 1]],
  [["C6", 4], ["Ab5", 1], ["C6", 1]], [["Db6", 2], ["C6", 2], ["Bb5", 2]],
  [["Ab5", 4], ["F5", 1], ["Ab5", 1]], [["Bb5", 4], ["G5", 1], ["Bb5", 1]],
  [["C6", 2], ["Db6", 2], ["Eb6", 2]], [["E6~", 6]],
  [["F6", 4], ["Eb6", 1], ["Db6", 1]], [["Eb6", 4], ["Db6", 1], ["C6", 1]],
  [["C6", 4], ["Bb5", 1], ["Ab5", 1]], [["G5~", 6]],
  [["F5", 2], ["Ab5", 2], ["Db6", 2]], [["Eb6", 3], ["Db6", 1], ["C6", 1], ["Bb5", 1]],
  [["C6", 4], ["Db6", 1], ["Eb6", 1]], [["E6~", 2], ["C6", 2], ["G5", 2]],
];

/** [start eighth, duration in eighths, MIDI note, scoop, velocity] */
type Note = [number, number, number, boolean, number];

type Voice = "lead" | "lead2" | "arp" | "bass";

function midi(name: string): number {
  const n = name.replace(/~$/, "");
  return 12 * (Number(n.slice(-1)) + 1) + PITCH[n.slice(0, -1)];
}

/** Lowest MIDI note of pitch class `pc` at or above `lo`. */
function up(pc: number, lo: number): number {
  return lo + (((pc - lo) % 12) + 12) % 12;
}

function section(bar: number): "A" | "A'" | "B" | "B'" {
  return (["A", "A'", "B", "B'"] as const)[Math.floor(bar / 8)];
}

export function buildScore(): Record<Voice, Note[]> {
  const s: Record<Voice, Note[]> = { lead: [], lead2: [], arp: [], bass: [] };

  MELODY.forEach((bar, b) => {
    let t = b * BAR;
    for (const [name, d] of bar) {
      const m = midi(name);
      const scoop = name.endsWith("~");
      const sec = section(b);
      s.lead.push([t, d, m, scoop, 1]);
      // A thin pulse doubles the tune an octave down, then an octave up at B'.
      if (sec === "A'" || sec === "B") s.lead2.push([t, d, m - 12, scoop, 0.55]);
      else if (sec === "B'") s.lead2.push([t, d, m < 84 ? m + 12 : m - 12, scoop, 0.4]);
      t += d;
    }
  });

  CHORDS.forEach((ch, b) => {
    const [r, t3, t5] = CHORD_TONES[ch].map((n) => PITCH[n]);
    const sec = section(b);
    const t0 = b * BAR;
    const isA = sec === "A" || sec === "A'";

    const root = up(r, isA ? 48 : 46);
    const sweep = isA
      ? [root, up(t3, root), up(t5, root), root + 12, up(t3, root + 12), up(t5, root + 12)]
      : [root, up(t5, root), root + 12, up(t3, root + 12), up(t5, root + 12), root + 12];
    sweep.forEach((n, i) => s.arp.push([t0 + i, 1, n, false, 1]));

    // The first four bars have no bass, so the opening is fragile.
    if (b < 4) return;
    const broot = up(r, 29);
    if (isA) {
      s.bass.push([t0, 4, broot, false, 1], [t0 + 4, 2, up(PITCH[WALK_A[ch]!], 29), false, 1]);
    } else {
      const five = up(t5, broot);
      s.bass.push(
        [t0, 2, broot, false, 1], [t0 + 2, 1, five, false, 0.8],
        [t0 + 3, 1, five, false, 0.7], [t0 + 4, 2, broot + 12, false, 0.85],
      );
    }
  });

  return s;
}

interface VoiceSpec {
  kind: "pulse" | "tri";
  duty: number;
  gate: number;
  attack: number;
  sustain: number;
  decay: number;
  vibrato: boolean;
  gain: number;
}

const VOICES: Record<Voice, VoiceSpec> = {
  lead: { kind: "pulse", duty: 0.5, gate: 0.92, attack: 1, sustain: 0.7, decay: 0.25, vibrato: true, gain: 0.22 },
  lead2: { kind: "pulse", duty: 0.125, gate: 0.92, attack: 1, sustain: 0.65, decay: 0.3, vibrato: true, gain: 0.16 },
  arp: { kind: "pulse", duty: 0.25, gate: 0.7, attack: 0.9, sustain: 0.35, decay: 0.1, vibrato: false, gain: 0.36 },
  bass: { kind: "tri", duty: 0, gate: 0.88, attack: 1, sustain: 1, decay: 1, vibrato: false, gain: 0.42 },
};

const RELEASE_S = 0.012;

function hz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

/** Adds one voice to `buf`, at the oversampled rate. */
function renderVoice(buf: Float32Array, spec: VoiceSpec, notes: Note[]): void {
  const relN = RELEASE_S * FS;
  for (const [st, d, m, scoop, vel] of notes) {
    const dur = d * EIGHTH;
    const gateS = d > 1 ? dur * spec.gate : dur * Math.min(spec.gate, 0.75);
    const n = Math.trunc((gateS + 0.02) * FS);
    const gateN = Math.trunc(gateS * FS);
    const i0 = Math.trunc(st * EIGHTH * FS);
    const len = Math.min(n, buf.length - i0);
    const base = hz(m);
    const bends = scoop || (spec.vibrato && gateS > 0.6);
    const decayStep = Math.exp(-1 / (spec.decay * FS));
    const amp = vel * spec.gain;

    let decay = 1;
    let ph = 0;
    for (let k = 0; k < len; k++) {
      let f = base;
      if (bends) {
        const t = k / FS;
        let semis = scoop ? -Math.max(0, 1 - t / 0.06) : 0;
        if (spec.vibrato && gateS > 0.6) {
          semis += Math.min(1, Math.max(0, (t - 0.35) / 0.3)) * 0.28 * Math.sin(2 * Math.PI * 5.6 * t);
        }
        f = base * 2 ** (semis / 12);
      }
      ph = (ph + f / FS) % 1;

      let osc: number;
      if (spec.kind === "pulse") {
        osc = ph < spec.duty ? 1 : -1;
      } else {
        // 32-step triangle: 16 levels up and down.
        osc = Math.round((2 - 4 * Math.abs(ph - 0.5)) * 7.5) / 7.5 - 1;
      }

      let e = spec.sustain + (spec.attack - spec.sustain) * decay;
      decay *= decayStep;
      if (k >= gateN) e *= Math.max(0, 1 - (k - gateN) / relN);
      // The APU's 16 volume steps.
      e = Math.round(Math.min(1, Math.max(0, e)) * 15) / 15;

      buf[i0 + k] += osc * e * amp;
    }
  }
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** Kaiser-windowed low-pass decimation by OS, as scipy's `resample_poly(x, 1, 4)`. */
function decimate(x: Float32Array): Float64Array {
  const taps = 2 * 10 * OS + 1;
  const half = (taps - 1) / 2;
  const beta = 5;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let j = 0; j < taps; j++) {
    const u = (j - half) / OS;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const w = besselI0(beta * Math.sqrt(1 - ((2 * j) / (taps - 1) - 1) ** 2)) / besselI0(beta);
    h[j] = sinc * w;
    sum += h[j];
  }
  for (let j = 0; j < taps; j++) h[j] /= sum;

  const out = new Float64Array(Math.ceil(x.length / OS));
  for (let k = 0; k < out.length; k++) {
    const c = k * OS + half;
    let acc = 0;
    if (c - (taps - 1) >= 0 && c < x.length) {
      for (let j = 0; j < taps; j++) acc += h[j] * x[c - j];
    } else {
      for (let j = 0; j < taps; j++) {
        const idx = c - j;
        if (idx >= 0 && idx < x.length) acc += h[j] * x[idx];
      }
    }
    out[k] = acc;
  }
  return out;
}

/** The console's output stage: a 30 Hz high-pass and a 14 kHz low-pass (Butterworth). */
function outputStage(y: Float64Array): void {
  const kh = Math.tan((Math.PI * 30) / SAMPLE_RATE);
  const hb0 = 1 / (1 + kh);
  const ha1 = (kh - 1) / (kh + 1);
  let hx1 = 0;
  let hy1 = 0;

  const kl = Math.tan((Math.PI * 14000) / SAMPLE_RATE);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + kl / q + kl * kl);
  const lb0 = kl * kl * norm;
  const la1 = 2 * (kl * kl - 1) * norm;
  const la2 = (1 - kl / q + kl * kl) * norm;
  let lx1 = 0, lx2 = 0, ly1 = 0, ly2 = 0;

  for (let i = 0; i < y.length; i++) {
    const x = y[i];
    const hp = hb0 * (x - hx1) - ha1 * hy1;
    hx1 = x;
    hy1 = hp;
    const lp = lb0 * (hp + 2 * lx1 + lx2) - la1 * ly1 - la2 * ly2;
    lx2 = lx1;
    lx1 = hp;
    ly2 = ly1;
    ly1 = lp;
    y[i] = lp;
  }
}

/**
 * Renders the 32-bar loop, mono at {@link SAMPLE_RATE}, peaking at 0.77. The
 * release tail past bar 32 is folded onto the start so the loop is seamless.
 * Takes most of a second on a desktop, so run it in a worker.
 */
export function renderQuietResolveLoop(): Float32Array<ArrayBuffer> {
  const score = buildScore();
  const loopS = BARS * BAR * EIGHTH;
  const mix = new Float32Array(Math.trunc((loopS + 0.6) * FS));
  for (const v of Object.keys(VOICES) as Voice[]) renderVoice(mix, VOICES[v], score[v]);

  const y = decimate(mix);
  outputStage(y);

  const n = Math.round(loopS * SAMPLE_RATE);
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < y.length; i++) {
    const j = i < n ? i : i - n;
    out[j] += y[i];
  }
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.77;
  return out;
}
