import { APP_NAME } from "@/lib/platform";

/**
 * A rose crest shape with the pulsing halo, drawn as two copies of the same
 * path: a glow copy carrying a *static* drop-shadow whose `opacity` pulses,
 * and the solid shape on top of it. Only the halo shows through.
 *
 * The glow used to be a single path animating `filter: drop-shadow()`
 * directly, but an animated `filter` re-runs the blur and repaints the subtree
 * every frame — the same reason `.animate-terminal-expand` in `index.css`
 * avoids it. Animating `opacity` over a filter that's rasterized once is a
 * compositor-only property change, and these crests run `infinite` on screens
 * (onboarding, and eight dialogs) that can stay open indefinitely.
 *
 * The inline `opacity: 0` is the resting value: CSS animations outrank inline
 * styles in the cascade, so the keyframes drive it while running, and under
 * `prefers-reduced-motion` (where `ArmadaCrestKeyframes` sets `animation:
 * none`) it falls back to a hidden halo — matching the old behavior, where
 * suppressing the animation left no filter at all.
 */
function GlowPath({ d }: { d: string }) {
  return (
    <>
      <path
        d={d}
        fill="hsl(var(--primary))"
        className="animate-[armada-glow_2.4s_ease-in-out_1.2s_infinite]"
        style={{ opacity: 0, filter: "drop-shadow(0 0 10px hsl(var(--primary) / 0.65))" }}
      />
      <path d={d} fill="hsl(var(--primary))" />
    </>
  );
}

/**
 * The animated Armada crest. Built from the same vessel silhouette as
 * `public/logo-mark.svg`, but split into independently-animated parts:
 *   - the cut-corner hull frame draws on (stroke-dash),
 *   - the rose "advancing-A" blade fades/scales up and pulses a glow,
 *   - the cyan wake strokes sweep left→right on a loop (the ship under way).
 * The whole crest rises into place ("sails up") on mount.
 *
 * Pair with {@link ArmadaCrestKeyframes} once per screen to register the
 * scoped keyframes it animates with.
 */
export function ArmadaCrest({ size = 132, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      role="img"
      aria-label={`${APP_NAME} logo`}
      className={`relative animate-[armada-rise_0.9s_cubic-bezier(0.22,1,0.36,1)_both] drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      {/* Cut-corner vessel crest: top-left & bottom-right chamfered. Draws on. */}
      <path
        d="M64 16 H232 a8 8 0 0 1 8 8 V192 L192 240 H24 a8 8 0 0 1 -8 -8 V64 Z"
        fill="none"
        stroke="hsl(var(--foreground) / 0.85)"
        strokeWidth="10"
        pathLength={1}
        className="animate-[armada-draw_1.1s_ease-out_0.15s_both]"
      />

      {/* The A as an advancing blade — rose, glowing pulse. */}
      <g
        className="animate-[armada-blade-in_0.7s_cubic-bezier(0.34,1.56,0.64,1)_0.5s_both]"
        style={{ transformOrigin: "128px 128px" }}
      >
        <GlowPath d="M128 56 L180 162 H158 L128 100 L98 162 H76 Z" />
        {/* Waterline crossbar (negative cut). */}
        <path d="M106 134 H150 L158 150 H98 Z" fill="hsl(var(--background))" />
      </g>

      {/* Cyan wake — sweeps L→R on a loop, as if the vessel is making way. */}
      <g stroke="hsl(var(--accent2, 180 90% 55%))" strokeLinecap="round">
        <path
          d="M88 184 H168"
          strokeWidth="6"
          pathLength={1}
          className="animate-[armada-wake_1.8s_ease-in-out_0.8s_infinite]"
        />
        <path
          d="M104 200 H152"
          strokeWidth="4"
          opacity="0.7"
          pathLength={1}
          className="animate-[armada-wake_1.8s_ease-in-out_1.0s_infinite]"
        />
      </g>
    </svg>
  );
}

/**
 * The animated secret-key mark, in the same visual language as the crest:
 *   - a cut-corner key bow (the grip) draws on like the crest frame,
 *   - the rose shaft-and-teeth blade fades/scales up and pulses a glow,
 *   - a rose "bit" diamond sits in the bow like the crest's advancing A,
 *   - the cyan wake sweeps beneath on the same loop,
 *   - and the whole key periodically turns in its lock.
 *
 * Used on the save-your-key step of onboarding. Pair with
 * {@link ArmadaCrestKeyframes} once per screen.
 */
export function ArmadaKey({ size = 132, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      role="img"
      aria-label="Secret key"
      className={`relative animate-[armada-rise_0.9s_cubic-bezier(0.22,1,0.36,1)_both] drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      {/* The key turns in its lock on a loop (after the entrance settles). */}
      <g
        className="animate-[armada-key-turn_4.5s_ease-in-out_1.8s_infinite]"
        style={{ transformOrigin: "76px 128px" }}
      >
        {/* Cut-corner key bow — draws on like the crest frame. */}
        <path
          d="M48 82 H104 L122 100 V156 L104 174 H48 L30 156 V100 Z"
          fill="none"
          stroke="hsl(var(--foreground) / 0.85)"
          strokeWidth="10"
          pathLength={1}
          className="animate-[armada-draw_1.1s_ease-out_0.15s_both]"
        />

        {/* Shaft + teeth and the bow bit — rose, glowing pulse. */}
        <g
          className="animate-[armada-blade-in_0.7s_cubic-bezier(0.34,1.56,0.64,1)_0.5s_both]"
          style={{ transformOrigin: "128px 128px" }}
        >
          <GlowPath d="M118 120 H228 V160 H212 V136 H196 V152 H180 V136 H118 Z" />
          {/* The bit: a rose diamond in the bow, echoing the crest's blade. */}
          <GlowPath d="M76 110 L94 128 L76 146 L58 128 Z" />
        </g>
      </g>

      {/* Cyan wake — same loop as the crest. */}
      <g stroke="hsl(var(--accent2, 180 90% 55%))" strokeLinecap="round">
        <path
          d="M88 200 H168"
          strokeWidth="6"
          pathLength={1}
          className="animate-[armada-wake_1.8s_ease-in-out_0.8s_infinite]"
        />
        <path
          d="M104 216 H152"
          strokeWidth="4"
          opacity="0.7"
          pathLength={1}
          className="animate-[armada-wake_1.8s_ease-in-out_1.0s_infinite]"
        />
      </g>
    </svg>
  );
}

/**
 * The animated identity mark for the profile step: a cut-corner badge frame
 * draws on, and a rose figure — diamond head over chamfered shoulders — rises
 * into it with the crest's springy entrance and glow. The cyan wake doubles
 * as the signature line. Pair with {@link ArmadaCrestKeyframes}.
 */
export function ArmadaIdentity({ size = 132, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      role="img"
      aria-label="Profile identity"
      className={`relative animate-[armada-rise_0.9s_cubic-bezier(0.22,1,0.36,1)_both] drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      {/* Cut-corner badge frame — draws on like the crest. */}
      <path
        d="M64 16 H232 a8 8 0 0 1 8 8 V192 L192 240 H24 a8 8 0 0 1 -8 -8 V64 Z"
        fill="none"
        stroke="hsl(var(--foreground) / 0.85)"
        strokeWidth="10"
        pathLength={1}
        className="animate-[armada-draw_1.1s_ease-out_0.15s_both]"
      />

      {/* The figure: diamond head over chamfered shoulders — rose, glowing. */}
      <g
        className="animate-[armada-blade-in_0.7s_cubic-bezier(0.34,1.56,0.64,1)_0.5s_both]"
        style={{ transformOrigin: "128px 120px" }}
      >
        <GlowPath d="M128 48 L160 80 L128 112 L96 80 Z" />
        <GlowPath d="M104 128 H152 L184 168 H72 Z" />
      </g>

      {/* Cyan signature line — the wake, writing the name. */}
      <g stroke="hsl(var(--accent2, 180 90% 55%))" strokeLinecap="round">
        <path
          d="M84 200 H172"
          strokeWidth="6"
          pathLength={1}
          className="animate-[armada-wake_1.8s_ease-in-out_0.8s_infinite]"
        />
        <path
          d="M100 216 H140"
          strokeWidth="4"
          opacity="0.7"
          pathLength={1}
          className="animate-[armada-wake_1.8s_ease-in-out_1.0s_infinite]"
        />
      </g>
    </svg>
  );
}

/**
 * Scoped keyframes for the crest + terminal. Inlined (rather than added to
 * tailwind.config) because they're SVG-specific (stroke-dash draws, the wake
 * sweep) and used only on the brand surfaces. Honors `prefers-reduced-motion`.
 * Render exactly once per screen that uses {@link ArmadaCrest} or the terminal.
 */
export function ArmadaCrestKeyframes() {
  return (
    <style>{`
      @keyframes armada-rise {
        from { opacity: 0; transform: translateY(18px) scale(0.94); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
      }
      @keyframes armada-draw {
        from { stroke-dasharray: 1; stroke-dashoffset: 1; }
        to   { stroke-dasharray: 1; stroke-dashoffset: 0; }
      }
      @keyframes armada-blade-in {
        from { opacity: 0; transform: scale(0.6); }
        to   { opacity: 1; transform: scale(1); }
      }
      /* Fades the halo layer painted by GlowPath. Compositor-only — see the
         note there for why this isn't an animated \`filter\`. */
      @keyframes armada-glow {
        0%, 100% { opacity: 0; }
        50%      { opacity: 1; }
      }
      @keyframes armada-wake {
        0%       { stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0; }
        25%      { opacity: 1; }
        60%      { stroke-dashoffset: 0; opacity: 1; }
        100%     { stroke-dasharray: 1; stroke-dashoffset: -1; opacity: 0; }
      }
      @keyframes armada-key-turn {
        0%, 55%, 100% { transform: rotate(0deg); }
        65%           { transform: rotate(-16deg); }
        78%           { transform: rotate(7deg); }
        88%           { transform: rotate(-2deg); }
      }
      @keyframes armada-swell {
        0%, 100% { opacity: 0.5; transform: scale(1); }
        50%      { opacity: 1;   transform: scale(1.06); }
      }
      @keyframes armada-caret {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
      @keyframes armada-line-in {
        from { opacity: 0; transform: translateY(3px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @media (prefers-reduced-motion: reduce) {
        [class*="animate-[armada-"] { animation: none !important; }
      }
    `}</style>
  );
}
