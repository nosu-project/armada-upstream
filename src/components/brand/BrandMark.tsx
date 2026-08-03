import { APP_NAME } from "@/lib/platform";

/**
 * The Armada wordmark + terminal tagline, echoing the OG card
 * (`public/og.svg`): a lowercase monospace wordmark in gilt-cream and a cyan
 * `$` prompt leading a magenta tagline, ending in a blinking caret. Flat, no
 * glow.
 *
 * `lines` adds extra muted `$` follow-up lines (short, punchy) below the
 * tagline; the blinking caret moves to the last line.
 */
export function BrandMark({
  align = "center",
  lines = [],
}: {
  align?: "center" | "left";
  lines?: string[];
}) {
  const items = align === "center" ? "items-center text-center" : "items-start text-left";
  return (
    <div className={`flex flex-col gap-1.5 font-mono ${items}`}>
      <span className="text-5xl font-bold lowercase tracking-tight text-foreground sm:text-6xl">
        {APP_NAME.toLowerCase()}
      </span>
      <span className="text-lg text-[hsl(var(--primary))]">
        <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
        a sovereign harbor on the open web
        {lines.length === 0 && (
          <span className="animate-[armada-caret_1s_step-end_infinite]">_</span>
        )}
      </span>
      {lines.map((line, i) => (
        <span key={line} className="text-lg text-foreground/55">
          <span className="text-[hsl(var(--accent2,180_90%_55%))]">$ </span>
          {line}
          {i === lines.length - 1 && (
            <span className="animate-[armada-caret_1s_step-end_infinite] text-[hsl(var(--primary))]">_</span>
          )}
        </span>
      ))}
    </div>
  );
}
