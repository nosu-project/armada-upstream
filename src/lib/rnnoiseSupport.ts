/**
 * Whether RNNoise can run in this environment: AudioWorklet support is
 * required, and the page's CSP must permit WebAssembly compilation
 * ('wasm-unsafe-eval' or 'unsafe-eval' in script-src).
 *
 * The CSP check matters because RNNoise's WASM instantiates *asynchronously
 * inside the AudioWorklet*: the main-thread processor setup succeeds, LiveKit
 * swaps the published mic track to the worklet's output, and only then does
 * the (CSP-blocked) instantiation fail — leaving the worklet outputting
 * silence with no error surfaced. Probing compilation here (worklet scopes
 * inherit the document's CSP) lets callers fall back to the raw mic track
 * instead of publishing a dead one.
 *
 * Lives in its own (dependency-free) module so surfaces that only need the
 * capability check — the settings page — don't pull the LiveKit SDK that
 * voiceProcessor.ts imports into their chunk.
 */

let wasmCompileAllowed: boolean | undefined;

function wasmSupported(): boolean {
  if (wasmCompileAllowed === undefined) {
    try {
      // The smallest valid module (magic + version). Throws a CompileError
      // when the CSP's script-src lacks 'wasm-unsafe-eval'/'unsafe-eval'.
      new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      wasmCompileAllowed = true;
    } catch {
      wasmCompileAllowed = false;
    }
  }
  return wasmCompileAllowed;
}

export function rnnoiseSupported(): boolean {
  return (
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof window !== "undefined" &&
    (typeof window.AudioContext !== "undefined" ||
      typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !==
        "undefined") &&
    wasmSupported()
  );
}
