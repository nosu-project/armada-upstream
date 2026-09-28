/**
 * "Note to Self" mark: a notepad glyph on a filled circle. At small sizes the
 * stroke thickens (hairlines go mushy on non-retina) and three writing lines drop to two.
 */

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

export const NOTE_TO_SELF_NAME = "Note to Self";

/** Matches the app's other avatar fallbacks. */
const ICON_TO_BACKGROUND_SCALE = 0.625;

export const NOTE_VIEWBOX = "0 0 24 24";

const PAGE = "M8 3h8a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z";

const LINES_FULL = "M8.5 8.5h7M8.5 12h7M8.5 15.5h7";
const LINES_COMPACT = "M8.5 10h7M8.5 14h7";

export function notePathsFor(sizePx: number): readonly string[] {
  return [PAGE, sizePx < 32 ? LINES_COMPACT : LINES_FULL];
}

/** Heavier as it gets smaller. */
export function noteStrokeFor(sizePx: number): number {
  if (sizePx >= 80) return 1.5;
  if (sizePx < 32) return 2.25;
  return 1.75;
}

/** Bare glyph; `sizePx` only picks stroke weight and line count, not dimensions. */
export function NoteToSelfIcon({
  sizePx = 48,
  className,
  style,
}: {
  sizePx?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox={NOTE_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={noteStrokeFor(sizePx)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      style={style}
    >
      {notePathsFor(sizePx).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Glyph on a filled circle. `sizePx` must match the rendered size from `className`. */
export function NoteToSelfAvatar({
  sizePx,
  className,
}: {
  sizePx: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary",
        className,
      )}
      aria-label={NOTE_TO_SELF_NAME}
    >
      <NoteToSelfIcon
        sizePx={sizePx}
        style={{ width: `${ICON_TO_BACKGROUND_SCALE * 100}%`, height: `${ICON_TO_BACKGROUND_SCALE * 100}%` }}
      />
    </span>
  );
}
