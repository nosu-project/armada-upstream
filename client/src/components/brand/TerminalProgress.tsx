import type { SyncLogLine } from "@/hooks/useInitialSync";

const TONE_CLASS: Record<NonNullable<SyncLogLine["tone"]>, string> = {
  ok: "text-[hsl(var(--success))]",
  info: "text-[hsl(var(--accent2,180_90%_55%))]",
  warn: "text-[hsl(var(--primary))]",
};

/**
 * A vertical, terminal-style progress list. Each sync step is a line: a cyan
 * `$` prompt, the step text, and a trailing state — a small spinning glyph
 * while the step runs, or its status chip (OK / 3 channels / …) once resolved.
 * Echoes the OG card's `$`-prompt terminal look; flat, no boxes or glow.
 */
export function TerminalProgress({ lines }: { lines: SyncLogLine[] }) {
  return (
    <div className="w-full max-w-sm font-mono text-sm leading-relaxed" aria-live="polite">
      {lines.map((line) => {
        const running = line.status === undefined;
        return (
          <div
            key={line.id}
            className="flex items-baseline gap-2 animate-[armada-line-in_0.2s_ease-out_both]"
          >
            <span className="select-none text-[hsl(var(--accent2,180_90%_55%))]">$</span>
            <span className="flex-1 text-foreground/80">{line.text}</span>
            {running ? (
              <span className="size-3 shrink-0 animate-spin rounded-full border border-foreground/25 border-t-[hsl(var(--primary))]" />
            ) : (
              <span className={`shrink-0 text-xs ${TONE_CLASS[line.tone ?? "ok"]}`}>
                {line.status}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
