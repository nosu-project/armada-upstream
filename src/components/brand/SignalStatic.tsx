import { useEffect, useRef } from "react";

import { CELL, FRAMES, SignalStaticField, WARMUP_FRAMES, hashSeed } from "./signalStaticField";

/**
 * Dead-channel interference over the jack-in screen.
 *
 * Coarse TV static whose strength tracks the REAL state of the link:
 * SyncGate feeds it a `level` derived from how many sync phases have actually
 * resolved, so the screen opens buried in interference and clears, step by
 * step, as the connection comes up — visor static in the Metroid Prime
 * manner, the sky over the port tuned to a dead channel. At `level` 0 the
 * field fades out (CSS transition on the host).
 *
 * The wire is in it for real twice over: the noise is seeded from the
 * operator's pubkey, and every `signal` change (SyncGate passes the live sync
 * log, so each phase resolution and each per-channel warmup tick is a real
 * relay round-trip) flashes a rose interference band at a position derived
 * from that event.
 *
 * There is NO draw loop. {@link SignalStaticField} is rendered once into a
 * tall sprite canvas ({@link FRAMES} stacked frames) and played back by a
 * compositor-driven `steps()` transform animation, so the flicker keeps
 * moving while the sync's own decrypt/store bursts block the main thread —
 * exactly the stalls that made a live rAF loop freeze and read as a lock-up.
 * The band flash is a one-shot WAAPI opacity animation, also compositor-run,
 * fired from JS that is by definition alive when the impulse arrives. Renders
 * nothing at all under prefers-reduced-motion — flicker is the whole effect,
 * and a frozen static frame just looks dirty.
 */
export function SignalStatic({
  level,
  seed,
  signal,
}: {
  level: number;
  seed: string;
  /** Opaque fingerprint of live wire activity; every change is an impulse. */
  signal?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // One-shot render of the whole loop (re-run only on resize): warm the
    // phosphor to steady state, then bake FRAMES consecutive frames into the
    // sprite, stacked vertically.
    const render = () => {
      const w = Math.max(1, Math.ceil(host.clientWidth / CELL));
      const h = Math.max(1, Math.ceil(host.clientHeight / CELL));
      canvas.width = w;
      canvas.height = h * FRAMES;
      const field = new SignalStaticField(hashSeed(seed));
      field.resize(w, h);
      for (let i = 0; i < WARMUP_FRAMES; i++) field.advance();
      for (let frame = 0; frame < FRAMES; frame++) {
        field.advance();
        field.paint(ctx, frame * h);
      }
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    return () => observer.disconnect();
  }, [seed]);

  // A wire impulse flashes the interference band at a position derived from
  // the event itself. One-shot WAAPI animation; nothing to clean up.
  useEffect(() => {
    const band = bandRef.current;
    if (signal === undefined || !band) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    band.style.top = `${5 + (hashSeed(signal) % 900) / 10}%`;
    band.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 300, easing: "ease-out" });
  }, [signal]);

  return (
    <div
      aria-hidden="true"
      // A flat-ish curve: visibly alive at the level floor, restrained at the
      // opening burst, zero once the link is up. A steep multiplier here is
      // what made the field vanish mid-sync ("the animation stopped").
      style={{ opacity: level > 0 ? 0.15 + 0.35 * level : 0 }}
      className="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700"
    >
      {/* The sprite reel: FRAMES viewport-tall frames, stepped through one
          per step. 2s / steps(24) must equal FRAMES / FPS from the field
          module. The backing store is tiny (cells, not pixels); the GPU does
          the pixelated upscale. */}
      <canvas
        ref={canvasRef}
        style={{ height: `${FRAMES * 100}%` }}
        className="absolute left-0 top-0 w-full animate-[armada-static-reel_2s_steps(24,end)_infinite] [image-rendering:pixelated]"
      />
      <div
        ref={bandRef}
        className="absolute inset-x-0 h-3 bg-gradient-to-b from-transparent via-[hsl(var(--primary)/0.6)] to-transparent opacity-0"
      />
      <style>{`
        @keyframes armada-static-reel {
          from { transform: translateY(0); }
          to   { transform: translateY(-100%); }
        }
      `}</style>
    </div>
  );
}
