// A published screen-share audio track must never carry the call's own playback.
// Requests aren't trusted (Chrome/Windows and Electron have ignored them): the
// verdict reads the track's actual settings, and anything not CONFIRMED clean is
// dropped. No shared audio is a gap; echo is the bug.
//
// Admitting bases:
//   restrictOwnAudio        the platform confirmed the restriction in settings.
//   callPlayoutCancelled    Chrome confirmed echo cancellation on display audio
//                           (reference = this page's peer-connection playout).
//   processExcludedLoopback Chromium's "loopbackWithoutChrome" (desktop, Win10 2004+).
//   venmic                  Linux PipeWire virtual mic excluding Electron by pid.
//   tabScoped               another tab's audio (own tab excluded from picker).
// Bare "loopback" (the unrestricted mix) is refused before any scoping rule. A
// WINDOW share is not a basis: below Windows 11 Chrome silently returns the system mix.
//
// The verdict is a pure function of settings; fixtures are measured values.

export type WindowAudioPreference = "exclude" | "window" | "system";

declare global {
  interface MediaTrackSettings {
    restrictOwnAudio?: boolean;
  }
  interface DisplayMediaStreamOptions {
    /** Which audio a WINDOW share carries: none, that window's, or the system's. */
    windowAudio?: WindowAudioPreference;
    /** Whether the capturing tab is offered in the picker. */
    selfBrowserSurface?: "include" | "exclude";
  }
}

const UNRESTRICTED_LOOPBACK = "loopback";
const PROCESS_EXCLUDED_LOOPBACK = "loopbackWithoutChrome";
/** The label desktop.ts gives venmic's PipeWire virtual microphone. */
const VENMIC_LABEL = "vencord-screen-share";

export type OwnAudioBasis =
  | "restrictOwnAudio"
  | "callPlayoutCancelled"
  | "processExcludedLoopback"
  | "venmic"
  | "tabScoped";

export type OwnAudioDropReason = "unrestrictedLoopback" | "unconfirmed";

export type OwnAudioVerdict =
  | { publish: true; basis: OwnAudioBasis }
  | { publish: false; reason: OwnAudioDropReason };

export interface OwnAudioEvidence {
  settings: MediaTrackSettings;
  label: string;
}

/** Whether a captured share audio track may be published. Pure; refuses anything unconfirmed. */
export function ownAudioVerdict(evidence: OwnAudioEvidence): OwnAudioVerdict {
  const { settings, label } = evidence;

  if (settings.restrictOwnAudio === true) {
    return { publish: true, basis: "restrictOwnAudio" };
  }
  // Before the loopback refusal: on web the cancelled track IS the loopback, and
  // display capture only gets echo cancellation when requested.
  if (settings.echoCancellation === true) {
    return { publish: true, basis: "callPlayoutCancelled" };
  }
  if (settings.deviceId === PROCESS_EXCLUDED_LOOPBACK) {
    return { publish: true, basis: "processExcludedLoopback" };
  }
  // The unrestricted mix is the echo; refuse it before surface-type scopes can admit it.
  if (settings.deviceId === UNRESTRICTED_LOOPBACK) {
    return { publish: false, reason: "unrestrictedLoopback" };
  }
  if (label === VENMIC_LABEL) {
    return { publish: true, basis: "venmic" };
  }
  if (settings.displaySurface === "browser") {
    return { publish: true, basis: "tabScoped" };
  }
  return { publish: false, reason: "unconfirmed" };
}

export interface DroppedOwnAudio {
  reason: OwnAudioDropReason;
  displaySurface?: string;
}

// The latest capture's drop, for the UI; overwritten by every capture.
let lastDrop: DroppedOwnAudio | null = null;

/** Drop (and stop) every audio track not confirmed free of call playback; returns what was dropped, or null. */
export function enforceOwnAudioExclusion(stream: MediaStream): DroppedOwnAudio | null {
  let dropped: DroppedOwnAudio | null = null;
  for (const track of stream.getAudioTracks()) {
    const settings = track.getSettings();
    const verdict = ownAudioVerdict({ settings, label: track.label });
    if (verdict.publish) continue;
    track.stop();
    stream.removeTrack(track);
    dropped = { reason: verdict.reason, displaySurface: settings.displaySurface };
  }
  lastDrop = dropped;
  return dropped;
}

/** Take (and clear) the drop recorded by the most recent capture. */
export function consumeOwnAudioDrop(): DroppedOwnAudio | null {
  const drop = lastDrop;
  lastDrop = null;
  return drop;
}

/** Read the most recent capture's drop without clearing it (diagnostics). */
export function peekOwnAudioDrop(): DroppedOwnAudio | null {
  return lastDrop;
}

/** Describe the admitted basis for the presenter's stream details. */
export function describeOwnAudioBasis(basis: OwnAudioBasis): string {
  switch (basis) {
    case "restrictOwnAudio":
      return "System audio, this app excluded by the browser";
    case "callPlayoutCancelled":
      return "System audio, the call cancelled out by the browser";
    case "processExcludedLoopback":
      return "System audio, this app excluded at the device";
    case "venmic":
      return "Application audio (PipeWire)";
    case "tabScoped":
      return "That tab's audio";
  }
}

/** The stream-details line for a share's audio: what is going out, or why nothing is. */
export function describeOwnAudioState(track: MediaStreamTrack | undefined): string {
  if (track) {
    const verdict = ownAudioVerdict({ settings: track.getSettings(), label: track.label });
    return verdict.publish ? describeOwnAudioBasis(verdict.basis) : "Unconfirmed";
  }
  const drop = peekOwnAudioDrop();
  if (!drop) return "Not captured";
  return drop.reason === "unrestrictedLoopback"
    ? "Left out: the system mix would carry the call"
    : "Left out: the browser did not confirm the call was excluded";
}

/** A user-facing explanation of why a share is going out without audio. */
export function describeOwnAudioDrop(drop: DroppedOwnAudio): string {
  const what = drop.displaySurface === "monitor" ? "Full-screen audio" : "This source's audio";
  const advice =
    drop.displaySurface === "monitor"
      ? " Share a window or a browser tab to include audio."
      : "";
  return `${what} would include the call itself and echo it back to everyone, so it was left out.${advice}`;
}
