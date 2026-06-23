import { APP_NAME } from "@/lib/platform";

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
        <path
          d="M128 56 L180 162 H158 L128 100 L98 162 H76 Z"
          fill="hsl(var(--primary))"
          className="animate-[armada-glow_2.4s_ease-in-out_1.2s_infinite]"
        />
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
      @keyframes armada-glow {
        0%, 100% { filter: drop-shadow(0 0 0 hsl(var(--primary) / 0)); }
        50%      { filter: drop-shadow(0 0 10px hsl(var(--primary) / 0.65)); }
      }
      @keyframes armada-wake {
        0%       { stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0; }
        25%      { opacity: 1; }
        60%      { stroke-dashoffset: 0; opacity: 1; }
        100%     { stroke-dasharray: 1; stroke-dashoffset: -1; opacity: 0; }
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
