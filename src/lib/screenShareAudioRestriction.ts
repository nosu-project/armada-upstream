// Keep a screen share's captured system audio from echoing the call back to it.
//
// When a user screen-shares WITH audio, the browser captures whatever the OS is
// playing — which, in a call, includes the OTHER participants' voices coming
// out of the sharer's speakers. That gets republished as the screen-share audio
// track, so everyone who spoke hears themselves (livekit/client-sdk-js#1799).
//
// Chrome 141+ excludes the capturing document's own audio output from the
// capture when `restrictOwnAudio: true` is set — as an AUDIO-TRACK constraint
// (`getDisplayMedia({ audio: { restrictOwnAudio: true } })`), the sibling of
// `suppressLocalAudioPlayback`. A top-level member of the options dictionary is
// silently ignored, so the flag MUST live inside `audio`. LiveKit's
// `screenCaptureToDisplayMediaStreamOptions()` maps a fixed set of properties
// and drops this one, so `setScreenShareEnabled({ audio: true })` cannot forward
// it — and the SDK issue was closed as not planned. The only place left to
// reintroduce it in-browser is a wrapper on `navigator.mediaDevices.getDisplayMedia`
// itself, which sits below every capture path (LiveKit's and our own direct
// `getDisplayMedia` in screenShare.ts).
//
// On the Electron desktop build the renderer's getDisplayMedia is served by the
// main process's setDisplayMediaRequestHandler, which grants Windows system
// audio as a native "loopback" source. Electron only swaps that for the
// own-audio-excluding "loopbackWithoutChrome" when it sees this constraint on
// the audio track, and only from Electron 43.4.0+ (electron/electron#52455;
// electronVersion.test.mjs guards the floor). Below that the flag is dropped and
// a Windows sharer on speakers still echoes every participant back.
//
// Injected only when audio is requested (the flag is meaningless for a
// video-only capture) and only where the caller has not already decided
// restrictOwnAudio. It is unknown to browsers before Chrome 141 and to
// Firefox/Safari, where an unrecognized constraint is simply ignored — so this
// is safe to set unconditionally on the audio path.

declare global {
  // Not yet in lib.dom. Chrome 141+ audio-track constraint, read only inside
  // `audio` (never as a top-level getDisplayMedia option).
  interface MediaTrackConstraints {
    restrictOwnAudio?: boolean;
  }
}

let installed = false;

/**
 * Wrap `navigator.mediaDevices.getDisplayMedia` so an audio capture always
 * carries `restrictOwnAudio` on its audio track constraints. Idempotent, and a
 * no-op where the API is absent.
 *
 * Call this AFTER `installDesktopDisplayMediaAudio()` so, on Electron/Linux,
 * this wrapper is outermost and the desktop venmic wrapper it delegates to still
 * runs unchanged. Injecting the flag there is harmless: Linux share audio comes
 * from PipeWire, not from getDisplayMedia's own audio, so the browser ignores
 * the flag while the venmic path is untouched.
 */
export function installScreenShareAudioRestriction(): void {
  if (installed || typeof navigator === "undefined") return;
  const mediaDevices = navigator.mediaDevices;
  if (typeof mediaDevices?.getDisplayMedia !== "function") return;

  installed = true;
  const original = mediaDevices.getDisplayMedia.bind(mediaDevices);
  mediaDevices.getDisplayMedia = (constraints?: DisplayMediaStreamOptions) => {
    if (constraints?.audio) {
      // Merge onto the audio track constraints, coercing `audio: true` to an
      // object — the only placement Chromium and Electron read. A caller that
      // already decided restrictOwnAudio is left untouched.
      const audio: MediaTrackConstraints =
        constraints.audio === true ? {} : { ...constraints.audio };
      if (audio.restrictOwnAudio === undefined) {
        audio.restrictOwnAudio = true;
        constraints = { ...constraints, audio };
      }
    }
    return original(constraints);
  };
}
