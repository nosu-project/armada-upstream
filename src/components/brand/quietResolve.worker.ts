/// <reference lib="webworker" />

import { renderQuietResolveLoop } from "./quietResolve";

export type QuietResolveResponse = { samples: Float32Array<ArrayBuffer> | null };

self.onmessage = () => {
  let samples: Float32Array<ArrayBuffer> | null = null;
  try {
    samples = renderQuietResolveLoop();
  } catch {
    samples = null;
  }
  self.postMessage({ samples } satisfies QuietResolveResponse, samples ? [samples.buffer] : []);
};
