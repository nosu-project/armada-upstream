/** [semitones above C5, start beat, length in beats] — a short brass flourish. */
const NOTES: [number, number, number][] = [
  [0, 0, 0.5],
  [0, 0.5, 0.25],
  [0, 0.75, 0.25],
  [4, 1, 0.5],
  [7, 1.5, 0.5],
  [12, 2, 1.75],
  [16, 2, 1.75],
  [19, 2, 1.75],
];

const BEAT = 0.22;
const C5 = 523.25;

/**
 * Schedules the fanfare on `ctx`, `delay` seconds from now. The context has to
 * be created inside a user gesture (autoplay policy), so callers make it on the
 * click and let the notes wait out whatever animation comes first.
 */
export function playFanfare(ctx: AudioContext, delay = 0): void {
  const start = ctx.currentTime + delay;
  const master = ctx.createGain();
  master.gain.value = 0.12;
  master.connect(ctx.destination);

  for (const [semitones, beat, length] of NOTES) {
    const t0 = start + beat * BEAT;
    const t1 = t0 + length * BEAT;
    const freq = C5 * 2 ** (semitones / 12);

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;

    // A brass-ish swell: the filter opens on the attack and closes on the release.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(freq * 1.5, t0);
    filter.frequency.linearRampToValueAtTime(freq * 6, t0 + 0.04);
    filter.frequency.exponentialRampToValueAtTime(freq * 2, t1);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.02);
    env.gain.setValueAtTime(0.8, t1 - 0.03);
    env.gain.exponentialRampToValueAtTime(0.001, t1 + 0.15);

    osc.connect(filter).connect(env).connect(master);
    osc.start(t0);
    osc.stop(t1 + 0.2);
  }

  const end = start + 4 * BEAT + 0.5;
  setTimeout(() => void ctx.close().catch(() => {}), (end - ctx.currentTime) * 1000);
}
