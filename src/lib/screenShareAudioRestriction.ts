// Keep a screen share's captured system audio from echoing the call back to it.
//
// When a user screen-shares WITH audio, the browser captures whatever the OS is
// playing — which, in a call, includes the OTHER participants' voices coming
// out of the sharer's speakers. That gets republished as the screen-share audio
// track, so everyone who spoke hears themselves (livekit/client-sdk-js#1799).
//
// Chrome 141+ excludes the capturing document's own audio output from the
// capture when `restrictOwnAudio: true` is passed to getDisplayMedia. LiveKit's
// `screenCaptureToDisplayMediaStreamOptions()` maps a fixed set of properties
// and drops this one, so `setScreenShareEnabled({ audio: true })` cannot forward
// it — and the SDK issue was closed as not planned. The only place left to
// reintroduce it in-browser is a wrapper on `navigator.mediaDevices.getDisplayMedia`
// itself, which sits below every capture path (LiveKit's and our own direct
// `getDisplayMedia` in screenShare.ts).
//
// Injected only when audio is actually requested: the flag is meaningless for a
// video-only capture, and this leaves a caller that set it explicitly alone. It
// is unknown to browsers before Chrome 141 and to Firefox/Safari, where an
// unrecognized DisplayMediaStreamOptions member is simply ignored — so this is
// safe to pass unconditionally on the audio path.

declare global {
  // Not yet in lib.dom. Chrome 141+ getDisplayMedia option.
  interface DisplayMediaStreamOptions {
    restrictOwnAudio?: boolean;
  }
}

let installed = false;

/**
 * Wrap `navigator.mediaDevices.getDisplayMedia` so an audio capture always
 * carries `restrictOwnAudio`. Idempotent, and a no-op where the API is absent.
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
    if (constraints?.audio && constraints.restrictOwnAudio === undefined) {
      constraints = { ...constraints, restrictOwnAudio: true };
    }
    return original(constraints);
  };
}
