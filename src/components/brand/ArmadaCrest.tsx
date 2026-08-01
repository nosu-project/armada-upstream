import { APP_NAME } from "@/lib/platform";

/**
 * The Armada mark, animated. Built from the same geometry as `public/logo.svg`
 * (a rose sail/"A" rising out of three cyan wave lines), split into
 * independently-animated parts. The path strings here are shared verbatim with
 * `public/logo.svg`, `index.html`'s boot splash, and
 * `android/.../drawable/crest_vector.xml` — keep them in sync.
 *
 * The motion is a one-shot *draw*, ~1.1s to settle:
 *
 * | t (s)       | what                                                     |
 * |-------------|----------------------------------------------------------|
 * | 0.00 – 0.66 | the three wave lines sweep open from the centerline       |
 * | 0.08 – 0.86 | a hairline stroke traces the sail's outline, then dissolves |
 * | 0.48 – 0.90 | the sail's fill floods in behind the trace                |
 * | 0.86 – 1.18 | the waterline caret inks in                               |
 * | 0.72 – 1.62 | a single halo sheen crosses the sail and fades out        |
 *
 * ...after which the mark rests as the static logo. Nothing loops unless a
 * surface opts in with `loop`, because most callers are dialogs that can stay
 * open indefinitely; only the boot/sync waits (where stillness reads as
 * "hung") ask for the idle wake.
 *
 * Every animated element's *static* state is its final resting state, with the
 * keyframes supplying only the entrance. That's what makes
 * `prefers-reduced-motion` — which kills the animations wholesale in
 * {@link ArmadaCrestKeyframes} — land on the finished mark rather than a
 * half-drawn one.
 */

// The rose sail / advancing A, with its open hull counter.
const SAIL =
  "M64 4.225l-39.97 88.5h17.13l2.31-5.2 2.76-6.22-2.22-1.43-1.42-12.84h9.99l4.89-11.01L64 41.335l11.42 25.7h9.99l-1.43 12.84-2.22 1.43 2.77 6.22 2.31 5.2h17.13z";
// The reflection caret under the sail (the waterline).
const CARET =
  "M76.84 79.165c-.15 0-.31-.05-.44-.15l-12.41-9.65-12.41 9.65c-.31.24-.76.19-1-.13a.706.706 0 0 1 .13-1l12.85-9.99c.26-.2.62-.2.88 0l12.85 9.99a.715.715 0 0 1-.43 1.28z";
// Three tapering wave lines. Each sweeps open on its own staggered beat.
const WAVES = [
  "M95.4 104.865H32.59c-1.18 0-2.14-.96-2.14-2.14s.96-2.14 2.14-2.14H95.4c1.18 0 2.14.96 2.14 2.14s-.96 2.14-2.14 2.14z",
  "M83.98 115.565H44.01a1.43 1.43 0 1 1 0-2.86h39.97a1.43 1.43 0 1 1 0 2.86z",
  "M73.99 123.775H54.01a1.071 1.071 0 0 1 0-2.14h19.98a1.071 1.071 0 0 1 0 2.14z",
];

// Eases, for reference — they have to appear as literals in the `animate-[…]`
// classes below, since Tailwind only generates utilities it can see spelled out
// in the source: `cubic-bezier(0.65,0,0.35,1)` is the pen (accelerate, then
// land) and `cubic-bezier(0.22,1,0.36,1)` is the sweep (expo-out, no bounce).

/**
 * One shape of the mark, drawn: a hairline stroke traces its outline, the
 * solid fill floods in behind the trace, and a halo sheen crosses it once as
 * it lands.
 *
 * Three stacked copies of the same path do the work:
 *
 * 1. the *sheen* — a copy carrying a **static** drop-shadow whose `opacity`
 *    is what animates. An animated `filter` re-runs the blur and repaints the
 *    subtree every frame (the same reason `.animate-terminal-expand` in
 *    `index.css` avoids it), whereas fading a filter that's rasterized once is
 *    a compositor-only change. Only the halo shows, since the solid fill sits
 *    directly on top.
 * 2. the *fill* — the shape itself, and the resting state of the whole group.
 * 3. the *trace* — stroke-only, `pathLength="1"` so the dash pattern is in
 *    normalized units regardless of the shape's real perimeter. It rests at
 *    `opacity: 0`; the keyframes reveal it, run the dash offset 1 → 0, and
 *    dissolve it once the fill has arrived.
 *
 * The inline `opacity` values are those resting states. CSS animations outrank
 * inline styles in the cascade, so the keyframes drive them while running.
 */
function DrawnPath({
  d,
  fillRule,
  delay = 0,
}: {
  d: string;
  fillRule?: "evenodd" | "nonzero";
  /** When this shape's trace begins. Its fill and sheen follow on fixed offsets. */
  delay?: number;
}) {
  return (
    <>
      <path
        d={d}
        fillRule={fillRule}
        fill="hsl(var(--primary))"
        className="animate-[armada-sheen_0.9s_ease-in-out_both]"
        style={{
          opacity: 0,
          filter: "drop-shadow(0 0 10px hsl(var(--primary) / 0.6))",
          animationDelay: `${delay + 0.64}s`,
        }}
      />
      <path
        d={d}
        fillRule={fillRule}
        fill="hsl(var(--primary))"
        className="animate-[armada-ink_0.42s_ease-out_both]"
        style={{ animationDelay: `${delay + 0.4}s` }}
      />
      <path
        d={d}
        fillRule={fillRule}
        pathLength={1}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-[armada-trace_0.78s_cubic-bezier(0.65,0,0.35,1)_both]"
        style={{ opacity: 0, strokeDasharray: 1, animationDelay: `${delay + 0.08}s` }}
      />
    </>
  );
}

/**
 * The three cyan wave lines. Each sweeps open horizontally on a staggered
 * beat, then scans slowly in and out on its own loop — a wake that keeps the
 * mark alive without competing with it.
 *
 * Both motions are `scaleX` about x=64, the mark's centerline, which is also
 * every line's own midpoint (so the lines grow and shrink symmetrically).
 * `transform-origin`'s y is irrelevant to a horizontal scale, hence the shared
 * `64px 0` and no need for `transform-box: fill-box`.
 *
 * The two animations sit on separate elements because they'd otherwise fight
 * over one `transform`: the entrance sweep on the path, the idle scan on a
 * wrapper `<g>` that multiplies into it. The scan starts *and* ends at
 * `scaleX(1)` so it picks up exactly where the sweep left off — starting it at
 * the narrow end would snap the moment its delay elapsed.
 */
function Waves() {
  return (
    <g fill="hsl(var(--accent2, 180 90% 55%))">
      {WAVES.map((d, i) => (
        <g
          key={i}
          className="animate-[armada-wake_6s_ease-in-out_infinite]"
          // No fill mode: before the delay elapses this contributes nothing, so
          // the sweep below owns the transform for the whole entrance. The
          // per-line offset keeps the three from scanning in unison.
          style={{ transformOrigin: "64px 0", animationDelay: `${0.9 + i * 0.6}s` }}
        >
          <path
            d={d}
            className="animate-[armada-sweep_0.52s_cubic-bezier(0.22,1,0.36,1)_both]"
            style={{ transformOrigin: "64px 0", animationDelay: `${i * 0.07}s` }}
          />
        </g>
      ))}
    </g>
  );
}

/**
 * The animated Armada crest: the cyan wake sweeps open, the rose sail traces
 * and inks itself in above it, and the mark settles — leaving only the waves
 * scanning slowly. Pair with {@link ArmadaCrestKeyframes} once per screen to
 * register the scoped keyframes it animates with.
 */
export function ArmadaCrest({ size = 132, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label={`${APP_NAME} logo`}
      className={`relative drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      <Waves />
      <DrawnPath d={SAIL} />
      <path
        d={CARET}
        fill="hsl(var(--primary))"
        fillOpacity={0.85}
        className="animate-[armada-ink_0.32s_ease-out_0.86s_both]"
      />
    </svg>
  );
}

/**
 * The animated secret-key mark, in the same visual language as the crest: the
 * cyan wake sweeps open, a frameless rose key traces and inks in above it, and
 * once it lands the key turns in its lock — a single flourish, not a loop.
 * Used on the save-your-key step of onboarding. Pair with
 * {@link ArmadaCrestKeyframes}.
 */
export function ArmadaKey({ size = 132, className = "" }: { size?: number; className?: string }) {
  // Diamond bow with a diamond hole (evenodd), and a shaft with two teeth.
  const bow = "M64 12 L88 34 L64 56 L40 34 Z M64 24 L52 34 L64 44 L76 34 Z";
  const shaft = "M58 52 H70 V64 H80 V72 H70 V80 H76 V88 H70 V92 H58 Z";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label="Secret key"
      className={`relative drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      <Waves />
      {/* The key turns in its lock once the draw has settled. */}
      <g
        className="animate-[armada-key-turn_1.1s_ease-in-out_1.3s_both]"
        style={{ transformOrigin: "64px 34px" }}
      >
        <DrawnPath d={bow} fillRule="evenodd" />
        <DrawnPath d={shaft} delay={0.22} />
      </g>
    </svg>
  );
}

/**
 * The animated identity mark for the profile step: a frameless rose figure —
 * diamond head over chamfered shoulders — traces and inks in above the same
 * sweeping cyan wake. Pair with {@link ArmadaCrestKeyframes}.
 */
export function ArmadaIdentity({ size = 132, className = "" }: { size?: number; className?: string }) {
  const head = "M64 22 L80 38 L64 54 L48 38 Z";
  const shoulders = "M52 62 H76 L92 84 H36 Z";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      role="img"
      aria-label="Profile identity"
      className={`relative drop-shadow-[0_8px_24px_hsl(var(--primary)/0.25)] ${className}`}
    >
      <Waves />
      <DrawnPath d={head} />
      <DrawnPath d={shoulders} delay={0.22} />
    </svg>
  );
}

/**
 * Scoped keyframes for the crest + terminal. Inlined (rather than added to
 * tailwind.config) because they're SVG-specific and used only on the brand
 * surfaces. Honors `prefers-reduced-motion`. Render exactly once per screen
 * that uses {@link ArmadaCrest} or the terminal.
 */
export function ArmadaCrestKeyframes() {
  return (
    <style>{`
      /* A hairline pen traces the outline, then dissolves as the fill lands.
         \`pathLength="1"\` on the path makes the dash pattern normalized. */
      @keyframes armada-trace {
        0%   { opacity: 1; stroke-dashoffset: 1; }
        76%  { opacity: 1; stroke-dashoffset: 0; }
        100% { opacity: 0; stroke-dashoffset: 0; }
      }
      /* The fill floods in behind the trace. */
      @keyframes armada-ink {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      /* A single halo pass as the shape lands. Compositor-only — see the note
         on DrawnPath for why this isn't an animated \`filter\`. */
      @keyframes armada-sheen {
        0%, 100% { opacity: 0; }
        45%      { opacity: 1; }
      }
      /* A wave line sweeping open from the mark's centerline. Starts at a
         sliver rather than 0: a zero-scale matrix is degenerate and some
         renderers drop the paint outright. */
      @keyframes armada-sweep {
        from { opacity: 0; transform: scaleX(0.15); }
        to   { opacity: 1; transform: scaleX(1); }
      }
      /* The idle wake: each line scans slowly in and out. Begins and ends at
         the settled width so it joins the entrance seamlessly. Transform only,
         so it stays on the compositor. */
      @keyframes armada-wake {
        0%, 100% { transform: scaleX(1); }
        50%      { transform: scaleX(0.78); }
      }
      @keyframes armada-key-turn {
        0%   { transform: rotate(0deg); }
        45%  { transform: rotate(-14deg); }
        75%  { transform: rotate(6deg); }
        100% { transform: rotate(0deg); }
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
