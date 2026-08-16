/**
 * The "Note to Self" mark: a notepad glyph inset on a filled circle, shown
 * wherever the DM surface refers to the conversation with yourself.
 *
 * The glyph is drawn here: a rounded-rectangle page with equal writing lines,
 * evenly spaced and centred, everything round-capped. Two things step by
 * rendered size, because the rail draws this at 16px where the glyph's own
 * box is 10px: the stroke thickens (a hairline lands under a physical pixel
 * there, which is grey mush on a non-retina screen), and the page drops from
 * three writing lines to two, since three lines a pixel apart read as noise
 * rather than writing.
 */

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** The conventional label for the conversation with yourself. */
export const NOTE_TO_SELF_NAME = "Note to Self";

/** The glyph's share of the circle, matching this app's other avatar fallbacks. */
const ICON_TO_BACKGROUND_SCALE = 0.625;

export const NOTE_VIEWBOX = "0 0 24 24";

/** The page: a 14 by 18 rounded rectangle, centred on the viewport. */
const PAGE = "M8 3h8a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z";

/** Three writing lines, centred on the page. */
const LINES_FULL = "M8.5 8.5h7M8.5 12h7M8.5 15.5h7";
/** Two, for renderings too small for three to stay distinct. */
const LINES_COMPACT = "M8.5 10h7M8.5 14h7";

/** The paths for a mark rendered at `sizePx`: the page, then its lines. */
export function notePathsFor(sizePx: number): readonly string[] {
  return [PAGE, sizePx < 32 ? LINES_COMPACT : LINES_FULL];
}

/**
 * The stroke weight for a mark rendered at `sizePx`. Heavier as it gets
 * smaller, which is the whole reason the size is passed down at all.
 */
export function noteStrokeFor(sizePx: number): number {
  if (sizePx >= 80) return 1.5;
  if (sizePx < 32) return 2.25;
  return 1.75;
}

/**
 * The bare notepad glyph, sized by whatever class the caller passes. `sizePx`
 * only picks the stroke weight and line count; it sets no dimensions.
 */
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

/**
 * The Note to Self avatar: the glyph on a filled circle, in place of the
 * viewer's own profile picture. `sizePx` must match the rendered size the
 * `className` sets, since it is what picks the weight and line count for
 * that size.
 */
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
