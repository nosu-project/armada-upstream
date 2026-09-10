// A published screen-share audio track must never carry the call's own playback.
//
// When a user shares WITH audio, the browser captures what the OS is playing —
// in a call, that includes the other participants' voices out of the sharer's
// speakers — and would republish it, so everyone who spoke hears themselves.
// Requesting `restrictOwnAudio` asks the platform to leave our own output out,
// but a request is not a guarantee: Chrome on Windows reports it as NOT applied
// to an entire-screen (system audio) capture, and the Electron desktop build's
// display-media handler was observed handing back the plain "loopback" mix for
// every surface with the constraint set. So nothing here trusts the request. The decision
// reads what the platform actually did back out of the track's settings, and a
// track that cannot be CONFIRMED clean is dropped before it is ever published.
// No shared audio is a gap; echo is the bug.
//
// The bases below are the only ways a track is known to exclude our playback.
// Each is a measured platform signal or a structural scope — never an
// assumption that a flag worked:
//   restrictOwnAudio        the platform confirmed the restriction in settings.
//   processExcludedLoopback Chromium's "loopbackWithoutChrome" device: system
//                           audio minus this app's audio service (WASAPI
//                           process loopback). The desktop shell grants it by
//                           name on Windows 10 2004+ (displayMediaPolicy.js).
//   venmic                  the Linux PipeWire virtual mic, which excludes the
//                           Electron audio service by pid (desktop.ts).
//   windowScoped            a window share captured with windowAudio:"window",
//                           i.e. that window's audio alone.
//   tabScoped               another tab's audio. The capturing tab itself is
//                           kept out of the picker (selfBrowserSurface).
// Chromium's bare "loopback" device is the unrestricted system mix — the exact
// source of the echo — and is refused BEFORE any scoping rule can admit it, so
// an Electron window share granted plain loopback is not mistaken for a
// window-scoped one.
//
// This is what makes the invariant testable without a human: the verdict is a
// pure function of the settings, and the fixtures are the values measured on
// real machines. When a platform starts confirming exclusion where it did not
// before, the setting flips and audio flows, with no code change.

export type WindowAudioPreference = "exclude" | "window" | "system";

declare global {
  // Not yet in lib.dom.
  interface MediaTrackSettings {
    /** Chrome 141+: whether the capture excludes the capturing document's audio. */
    restrictOwnAudio?: boolean;
  }
  interface DisplayMediaStreamOptions {
    /** Which audio a WINDOW share carries: none, that window's, or the system's. */
    windowAudio?: WindowAudioPreference;
    /** Whether the capturing tab is offered in the picker. */
    selfBrowserSurface?: "include" | "exclude";
  }
}

/** Chromium's device id for the unrestricted system-audio mix. */
const UNRESTRICTED_LOOPBACK = "loopback";
/** Chromium's device id for system audio minus this process. */
const PROCESS_EXCLUDED_LOOPBACK = "loopbackWithoutChrome";
/** The label desktop.ts gives venmic's PipeWire virtual microphone. */
const VENMIC_LABEL = "vencord-screen-share";

export type OwnAudioBasis =
  | "restrictOwnAudio"
  | "processExcludedLoopback"
  | "venmic"
  | "windowScoped"
  | "tabScoped";

export type OwnAudioDropReason = "unrestrictedLoopback" | "unconfirmed";

export type OwnAudioVerdict =
  | { publish: true; basis: OwnAudioBasis }
  | { publish: false; reason: OwnAudioDropReason };

export interface OwnAudioEvidence {
  /** The track's settings, as reported by the platform after capture. */
  settings: MediaTrackSettings;
  /** The track's label (identifies venmic). */
  label: string;
  /** The `windowAudio` the capture REQUESTED, which scopes a window share. */
  requestedWindowAudio?: WindowAudioPreference;
}

/**
 * Decide whether a captured screen-share audio track may be published.
 *
 * Pure: reads only the evidence handed to it, so every platform observation
 * becomes a fixture. Refuses anything it cannot positively confirm.
 */
export function ownAudioVerdict(evidence: OwnAudioEvidence): OwnAudioVerdict {
  const { settings, label, requestedWindowAudio } = evidence;

  if (settings.restrictOwnAudio === true) {
    return { publish: true, basis: "restrictOwnAudio" };
  }
  if (settings.deviceId === PROCESS_EXCLUDED_LOOPBACK) {
    return { publish: true, basis: "processExcludedLoopback" };
  }
  // The unrestricted system mix is the echo. Refused here, ahead of the
  // structural scopes, so nothing below can admit it by surface type.
  if (settings.deviceId === UNRESTRICTED_LOOPBACK) {
    return { publish: false, reason: "unrestrictedLoopback" };
  }
  if (label === VENMIC_LABEL) {
    return { publish: true, basis: "venmic" };
  }
  if (settings.displaySurface === "window" && requestedWindowAudio === "window") {
    return { publish: true, basis: "windowScoped" };
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

// The most recent capture's drop, for the UI to explain. Every capture
// overwrites it (a clean capture writes null), so a stale record cannot
// outlive the capture it describes; the UI also discards it on failure.
let lastDrop: DroppedOwnAudio | null = null;

/**
 * Remove from `stream` every audio track that cannot be confirmed free of the
 * call's own playback, stopping each so the capture releases it. Returns what
 * was dropped, or null when every audio track (if any) was admitted.
 */
export function enforceOwnAudioExclusion(
  stream: MediaStream,
  requested: { windowAudio?: WindowAudioPreference } = {},
): DroppedOwnAudio | null {
  let dropped: DroppedOwnAudio | null = null;
  for (const track of stream.getAudioTracks()) {
    const settings = track.getSettings();
    const verdict = ownAudioVerdict({
      settings,
      label: track.label,
      requestedWindowAudio: requested.windowAudio,
    });
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

/** A user-facing explanation of why a share is going out without audio. */
export function describeOwnAudioDrop(drop: DroppedOwnAudio): string {
  const what = drop.displaySurface === "monitor" ? "Full-screen audio" : "This source's audio";
  const advice =
    drop.displaySurface === "monitor"
      ? " Share a window or a browser tab to include audio."
      : "";
  return `${what} would include the call itself and echo it back to everyone, so it was left out.${advice}`;
}
