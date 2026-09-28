/**
 * Whether RNNoise can run: AudioWorklet plus a CSP allowing wasm compilation.
 * Otherwise the worklet's async wasm instantiation fails after LiveKit already
 * swapped in its output, publishing silence. Dependency-free so settings
 * doesn't pull in the LiveKit SDK.
 */

let wasmCompileAllowed: boolean | undefined;

function wasmSupported(): boolean {
  if (wasmCompileAllowed === undefined) {
    try {
      // Smallest valid module; throws a CompileError without 'wasm-unsafe-eval'/'unsafe-eval'.
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
