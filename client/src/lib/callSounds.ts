/**
 * Tiny synthesized UI sounds for voice calls, generated with the Web Audio API
 * so there are no audio assets to ship. Two short, friendly blips: a rising
 * two-note chirp when someone joins, a gentler falling one when they leave.
 */

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      ctx = new Ctx();
    }
    // Browsers may suspend the context until a user gesture; resume best-effort.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Play a short two-note sequence. Each note is a softly enveloped sine. */
function playNotes(notes: { freq: number; start: number; dur: number }[], gainPeak: number): void {
  const ac = audioContext();
  if (!ac) return;
  const now = ac.currentTime;
  for (const { freq, start, dur } of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const t0 = now + start;
    // Quick attack, smooth exponential-ish decay to avoid clicks.
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(gainPeak, t0 + 0.02);
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
}

/** Rising chirp: someone joined. (C6 → E6) */
export function playJoinSound(): void {
  playNotes(
    [
      { freq: 1046.5, start: 0, dur: 0.12 },
      { freq: 1318.5, start: 0.1, dur: 0.16 },
    ],
    0.12,
  );
}

/** Falling chirp: someone left. (E6 → C6) */
export function playLeaveSound(): void {
  playNotes(
    [
      { freq: 1318.5, start: 0, dur: 0.12 },
      { freq: 987.77, start: 0.1, dur: 0.18 },
    ],
    0.1,
  );
}

/**
 * Self-only mute/unmute feedback. These are single short blips, lower and
 * shorter than the join/leave chirps so they read as a personal toggle rather
 * than a roster change. Only ever played to the local user.
 */

/** Muted yourself: a low, soft downward blip. (A4 → F4) */
export function playMuteSound(): void {
  playNotes(
    [
      { freq: 440, start: 0, dur: 0.07 },
      { freq: 349.23, start: 0.06, dur: 0.1 },
    ],
    0.09,
  );
}

/** Unmuted yourself: a low, soft upward blip. (F4 → A4) */
export function playUnmuteSound(): void {
  playNotes(
    [
      { freq: 349.23, start: 0, dur: 0.07 },
      { freq: 440, start: 0.06, dur: 0.1 },
    ],
    0.09,
  );
}

/**
 * A screenshare started: a bright, rising three-note arpeggio (C6 → E6 → G6)
 * to mark the more notable event of a screen going live, distinct from the
 * two-note join chirp.
 */
export function playScreenShareSound(): void {
  playNotes(
    [
      { freq: 1046.5, start: 0, dur: 0.1 },
      { freq: 1318.5, start: 0.09, dur: 0.1 },
      { freq: 1568, start: 0.18, dur: 0.18 },
    ],
    0.11,
  );
}
