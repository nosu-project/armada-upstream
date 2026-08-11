import { useEffect, useState } from "react";

import type { SyncLogLine } from "@/hooks/useInitialSync";

const TONE_CLASS: Record<NonNullable<SyncLogLine["tone"]>, string> = {
  ok: "text-[hsl(var(--success))]",
  info: "text-[hsl(var(--accent2,180_90%_55%))]",
  warn: "text-[hsl(var(--primary))]",
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** ASCII-only spinner — Braille spinner glyphs are tofu on Android's Roboto. */
const SPINNER_GLYPHS = ["|", "/", "-", "\\"];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_GLYPHS.length), 140);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="shrink-0 text-xs text-[hsl(var(--accent2,180_90%_55%))]">
      {SPINNER_GLYPHS[frame]}
    </span>
  );
}

/** Scramble pool. Hex-flavored; spaces and `/` keep their place so the chip's
 * width (mono) and shape never jump during the decode. */
const DECODE_GLYPHS = "0123456789ABCDEF#$%&";
const DECODE_FRAMES = 8;
const DECODE_FRAME_MS = 35;

function scrambled(status: string, settled: number): string {
  let out = status.slice(0, settled);
  for (const ch of status.slice(settled)) {
    out += ch === " " || ch === "/"
      ? ch
      : DECODE_GLYPHS[Math.floor(Math.random() * DECODE_GLYPHS.length)];
  }
  return out;
}

/**
 * A resolved status chip that descrambles into its real text: ~300ms of
 * glyph noise settling left to right, then the actual status. Fires once, at
 * the moment the step actually resolved — the flourish marks a real event.
 */
function DecodeChip({ status, className }: { status: string; className: string }) {
  const [text, setText] = useState(() => (prefersReducedMotion() ? status : scrambled(status, 0)));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setText(status);
      return;
    }
    let frame = 0;
    const t = setInterval(() => {
      frame++;
      if (frame >= DECODE_FRAMES) {
        setText(status);
        clearInterval(t);
        return;
      }
      setText(scrambled(status, Math.floor((frame / DECODE_FRAMES) * status.length)));
    }, DECODE_FRAME_MS);
    return () => clearInterval(t);
  }, [status]);
  return <span className={`shrink-0 text-xs ${className}`}>{text}</span>;
}

/** Live `x/y` progress as a terminal cell bar: `[███░░░░░] 3/8`. */
function BarChip({ done, total }: { done: number; total: number }) {
  const cells = 8;
  const filled = total > 0 ? Math.min(cells, Math.round((done / total) * cells)) : 0;
  return (
    <span className="shrink-0 text-xs text-[hsl(var(--accent2,180_90%_55%))]">
      [{"█".repeat(filled)}{"░".repeat(cells - filled)}] {done}/{total}
    </span>
  );
}

/**
 * A vertical, terminal-style progress list. Each sync step is a line: a cyan
 * `$` prompt, the step text, and a trailing state — an ASCII spinner while
 * the step runs, a live `[███░░]` bar for x/y progress, or a status chip that
 * descrambles into place once resolved. Resolved lines dim so the eye stays
 * on the step that's working, and a bare `$ _` prompt below the log keeps the
 * shell visibly alive between steps. Echoes the OG card's `$`-prompt terminal
 * look; flat, no boxes or glow.
 */
export function TerminalProgress({ lines }: { lines: SyncLogLine[] }) {
  return (
    <div className="w-full max-w-sm font-mono text-sm leading-relaxed" aria-live="polite">
      {lines.map((line) => {
        const running = line.status === undefined;
        // Tone marks a FINAL state; a toneless status is live x/y progress.
        const resolved = line.tone !== undefined && line.status !== undefined;
        const progress = !resolved && line.status?.match(/^(\d+)\/(\d+)$/);
        return (
          <div
            key={line.id}
            className="flex items-baseline gap-2 animate-[armada-line-in_0.2s_ease-out_both]"
          >
            <span
              className={`select-none ${
                resolved
                  ? "text-[hsl(var(--accent2,180_90%_55%)/0.45)]"
                  : "text-[hsl(var(--accent2,180_90%_55%))]"
              }`}
            >
              $
            </span>
            <span
              className={`flex-1 transition-colors duration-300 ${
                resolved ? "text-foreground/45" : "text-foreground/85"
              }`}
            >
              {line.text}
            </span>
            {running ? (
              <Spinner />
            ) : progress ? (
              <BarChip done={Number(progress[1])} total={Number(progress[2])} />
            ) : (
              <DecodeChip status={line.status!} className={TONE_CLASS[line.tone ?? "ok"]} />
            )}
          </div>
        );
      })}
      {/* The shell waiting between steps. `armada-caret` comes from
          ArmadaCrestKeyframes, mounted on every screen that renders this. */}
      <div className="flex items-baseline gap-2">
        <span className="select-none text-[hsl(var(--accent2,180_90%_55%))]">$</span>
        <span className="animate-[armada-caret_1s_step-end_infinite] text-[hsl(var(--primary))]">_</span>
      </div>
    </div>
  );
}
