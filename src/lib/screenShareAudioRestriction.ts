// Keep screen-share system audio from echoing the call back (livekit/client-sdk-js#1799).
//
// Chrome 141+ honors `restrictOwnAudio: true` only as an AUDIO-track constraint
// (inside `audio`; top-level is ignored). LiveKit drops it, so we wrap
// `navigator.mediaDevices.getDisplayMedia`, below every capture path.
//
// Electron: electron/displayMediaPolicy.js grants "loopbackWithoutChrome"
// directly (as Vesktop does, Vencord/Vesktop#1294); this constraint is harmless there.
//
// Web on Windows 10 (where Chrome refuses restrictOwnAudio): also request
// `echoCancellation` on display audio, which cancels this page's peer-connection
// playout (Google Meet's approach). Web only: on desktop it would just cost fidelity.
//
// Injected only for audio captures and only where the caller hasn't decided;
// browsers that don't know the constraint ignore it.

import { isDesktop } from "@/lib/desktop";
import { enforceOwnAudioExclusion } from "@/lib/screenShareOwnAudio";

declare global {
  // Not yet in lib.dom; valid only inside `audio`.
  interface MediaTrackConstraints {
    restrictOwnAudio?: boolean;
  }
}

let installed = false;

/**
 * Wrap `getDisplayMedia` so audio captures carry `restrictOwnAudio`. Idempotent;
 * no-op without the API. Call AFTER `installDesktopDisplayMediaAudio()` so this
 * wrapper is outermost (Linux venmic audio is unaffected).
 */
export function installScreenShareAudioRestriction(
  options: {
    /** Ask Chrome to cancel this page's call playout from the system audio. Defaults to web only. */
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
      // Coerce `audio: true` to an object (the only placement read); keep caller-decided flags.
      const audio: MediaTrackConstraints =
        constraints.audio === true ? {} : { ...constraints.audio };
      if (audio.restrictOwnAudio === undefined) audio.restrictOwnAudio = true;
      if (cancelCallPlayout && audio.echoCancellation === undefined) {
        audio.echoCancellation = true;
      }
      constraints = {
        ...constraints,
        audio,
        // Scope window shares to their own audio and keep this tab out of the picker.
        windowAudio: constraints.windowAudio ?? "window",
        selfBrowserSurface: constraints.selfBrowserSurface ?? "exclude",
      };
    }
    const stream = await original(constraints);
    // The above are requests; drop any audio we can't confirm is free of our playback.
    enforceOwnAudioExclusion(stream);
    return stream;
  };
}
