import { useEffect } from "react";

import { SAMPLE_RATE } from "./quietResolve";
import type { QuietResolveResponse } from "./quietResolve.worker";

const VOLUME = 0.35;
const FADE_IN_S = 2;
const FADE_S = 0.3;

/**
 * Loops the wreck page's theme ("Quiet Resolve", synthesized in a worker)
 * while mounted. A context the autoplay policy suspends starts on the next
 * gesture.
 */
export function useWreckMusic(): void {
  useEffect(() => {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx || typeof Worker === "undefined") return;

    let ac: AudioContext;
    try {
      ac = new Ctx({ latencyHint: "playback" });
    } catch {
      return;
    }
    let cancelled = false;
    const gain = ac.createGain();
    gain.gain.value = 0;
    gain.connect(ac.destination);

    const resume = () => {
      if (ac.state === "suspended") void ac.resume().catch(() => {});
    };
    const events = ["pointerdown", "keydown", "touchend"] as const;
    for (const e of events) window.addEventListener(e, resume, { capture: true });

    const worker = new Worker(new URL("./quietResolve.worker.ts", import.meta.url), { type: "module" });
    worker.onerror = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<QuietResolveResponse>) => {
      worker.terminate();
      const { samples } = event.data;
      if (cancelled || !samples) return;
      try {
        const buffer = ac.createBuffer(1, samples.length, SAMPLE_RATE);
        buffer.copyToChannel(samples, 0);
        const source = ac.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start();
        const now = ac.currentTime;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(VOLUME, now + FADE_IN_S);
        resume();
      } catch {
        // No usable output: the page works silently.
      }
    };
    worker.postMessage(null);

    return () => {
      cancelled = true;
      worker.terminate();
      for (const e of events) window.removeEventListener(e, resume, { capture: true });
      try {
        const now = ac.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      } catch { /* ignore */ }
      setTimeout(() => void ac.close().catch(() => {}), FADE_S * 1000 + 50);
    };
  }, []);
}
