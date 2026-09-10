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
// On the Electron desktop build this constraint is NOT what keeps the call out
// of a Windows share. There the renderer's getDisplayMedia is served by the
// main process's setDisplayMediaRequestHandler, and the audio track is whatever
// loopback device that handler names — Electron maps this constraint onto it
// only from 43.4.0, and only when Chromium populates the request, which in the
// field it did not (every surface came back as the plain "loopback" mix). So
// electron/displayMediaPolicy.js grants Chromium's own-process-excluding
// "loopbackWithoutChrome" device DIRECTLY, the way Vesktop does
// (Vencord/Vesktop#1294); the constraint here still rides along for the web
// build and is harmless on the desktop one.
//
// Chrome refuses restrictOwnAudio below Windows 11 outright, so on the WEB
// build on Windows 10 there is a second request beside it: `echoCancellation`
// on the display audio. Chromium's display-capture path
// (MaybeMakeForProcessedDisplayCapture) then runs its WebRTC echo canceller on
// the captured system audio with this page's own peer-connection playout as
// the reference — "to only remove PeerConnection playout", i.e. exactly the
// other participants' voices — and it has no Windows-version gate. This is how
// Google Meet shares system audio on Windows 10 without echo. It is requested
// on the web build only: the desktop shell already excludes its own audio at
// the device (displayMediaPolicy.js), and a canceller on top of a clean signal
// can only cost fidelity. Chrome confirms it in the track's settings, which is
// the basis ownAudioVerdict() admits it on.
//
// Injected only when audio is requested (the flags are meaningless for a
// video-only capture) and only where the caller has not already decided them.
// restrictOwnAudio is unknown to browsers before Chrome 141 and to
// Firefox/Safari, where an unrecognized constraint is simply ignored — so this
// is safe to set unconditionally on the audio path.

import { isDesktop } from "@/lib/desktop";
import { enforceOwnAudioExclusion } from "@/lib/screenShareOwnAudio";

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
export function installScreenShareAudioRestriction(
  options: {
    /**
     * Ask Chrome to cancel this page's own call playout out of the captured
     * system audio. Defaults to the web build only; the desktop shell excludes
     * its own audio at the device instead.
     */
    cancelCallPlayout?: boolean;
  } = {},
): void {
  if (installed || typeof navigator === "undefined") return;
  const mediaDevices = navigator.mediaDevices;
  if (typeof mediaDevices?.getDisplayMedia !== "function") return;

  installed = true;
  const cancelCallPlayout = options.cancelCallPlayout ?? !isDesktop();
  const original = mediaDevices.getDisplayMedia.bind(mediaDevices);
  mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
    if (constraints?.audio) {
      // Merge onto the audio track constraints, coercing `audio: true` to an
      // object — the only placement Chromium and Electron read. A caller that
      // already decided a flag is left untouched.
      const audio: MediaTrackConstraints =
        constraints.audio === true ? {} : { ...constraints.audio };
      if (audio.restrictOwnAudio === undefined) audio.restrictOwnAudio = true;
      if (cancelCallPlayout && audio.echoCancellation === undefined) {
        audio.echoCancellation = true;
      }
      constraints = {
        ...constraints,
        audio,
        // Scope a window share to that window's own audio, and keep this tab
        // out of the picker. Both make a capture structurally unable to carry
        // the call — which is what ownAudioVerdict() can then confirm.
        windowAudio: constraints.windowAudio ?? "window",
        selfBrowserSurface: constraints.selfBrowserSurface ?? "exclude",
      };
    }
    const stream = await original(constraints);
    // Everything above is a REQUEST. This reads back what the platform did and
    // drops any audio it cannot confirm is free of our own playback.
    enforceOwnAudioExclusion(stream);
    return stream;
  };
}
