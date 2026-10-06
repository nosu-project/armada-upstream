import { Capacitor } from "@capacitor/core";

import { micCaptureConstraints } from "@/lib/voiceDevices";

/**
 * Chromium on Android enters MODE_IN_COMMUNICATION on its first processed mic
 * capture and leaves it when the last one closes, and a playback stream takes
 * its usage from that state when it opens. Calls join muted, so the remote
 * audio opens as USAGE_MEDIA (no echo-canceller reference, keys on the wrong
 * stream), and every unmute, processing toggle, headset plug or rejoin flaps
 * the mode and the route. One capture held from before connect to hang-up
 * keeps the mode on for the whole call. Only a stream opened after it counts,
 * and an output stream already open with the same settings is shared, not
 * reopened (see callSounds.ts). Android only: elsewhere the mode does
 * not exist and a muted call would show a live mic indicator.
 */
export function shouldHoldCallMic(): boolean {
  return Capacitor.getPlatform() === "android";
}

/** Opens the capture; resolves to its release. Rejects when the mic is unavailable. */
export async function holdCallMic(): Promise<() => void> {
  const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!devices?.getUserMedia) throw new Error("Media devices are unavailable.");
  // Chromium only switches the mode for a capture with effects, so this one
  // keeps echo cancellation whatever the user's publish prefs say.
  const constraints = { ...micCaptureConstraints(), echoCancellation: true };
  let tracks: MediaStreamTrack[] = [];
  let released = false;

  const acquire = async () => {
    const stream = await devices.getUserMedia({ audio: constraints });
    tracks = stream.getAudioTracks();
    for (const track of tracks) {
      // A lost device ends the track; reopen once so the mode doesn't drop mid-call.
      track.addEventListener("ended", () => {
        if (!released) void acquire().catch(() => {});
      }, { once: true });
    }
  };

  await acquire();
  return () => {
    released = true;
    for (const track of tracks) track.stop();
  };
}
