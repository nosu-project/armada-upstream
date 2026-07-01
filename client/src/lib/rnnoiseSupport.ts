/**
 * Whether RNNoise can run in this environment: AudioWorklet support is required.
 * Used to hide the toggle / skip applying the processor where it can't work.
 *
 * Lives in its own (dependency-free) module so surfaces that only need the
 * capability check — the settings page — don't pull the LiveKit SDK that
 * voiceProcessor.ts imports into their chunk.
 */
export function rnnoiseSupported(): boolean {
  return (
    typeof AudioWorkletNode !== "undefined" &&
    typeof window !== "undefined" &&
    (typeof window.AudioContext !== "undefined" ||
      typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !==
        "undefined")
  );
}
