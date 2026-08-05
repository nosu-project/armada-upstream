/**
 * Signal's "Note to Self" mark: a notepad glyph inset on a filled circle,
 * shown wherever the DM surface refers to the conversation with yourself.
 *
 * ARTWORK PROVENANCE. The three glyph strips below are the `symbol_note_*`
 * vector drawables from Signal-Android (github.com/signalapp/Signal-Android,
 * `app/src/main/res/drawable/`), Copyright (C) Signal Messenger, LLC, used
 * under the GNU Affero General Public License v3. Each Android `<vector>`
 * carried four `android:pathData` strings, reproduced here unchanged as SVG
 * `d` attributes on that vector's own viewport. Armada is AGPL-3.0 too, so the
 * copy is license-compatible; see the README's License section. Nothing about
 * the geometry is ours.
 *
 * Both of Signal's sizing rules are kept, because they are what make it read
 * as the same mark rather than a notepad in a circle: the strip is chosen by
 * rendered size (`FallbackAvatar.getSizeByDp` — under 32dp compact, 80dp and
 * up display-bold, medium in between), and the glyph is inset to 0.625 of the
 * circle (`ICON_TO_BACKGROUND_SCALE`).
 *
 * The colours are Armada's. Signal tints the circle with the recipient's
 * assigned avatar colour, which this app has no equivalent of, so it takes the
 * same primary tint every other DM avatar fallback here uses.
 */

import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** Signal's own label for the conversation with yourself (`R.string.note_to_self`). */
export const NOTE_TO_SELF_NAME = "Note to Self";

/** Signal's `ICON_TO_BACKGROUND_SCALE` — the glyph's share of the circle. */
const ICON_TO_BACKGROUND_SCALE = 0.625;

interface NoteStrip {
  viewBox: string;
  paths: readonly string[];
}

/** `symbol_note_compact_16` — Signal's SMALL fallback (under 32dp). */
const NOTE_COMPACT_16: NoteStrip = {
  viewBox: "0 0 16 16",
  paths: [
    "M5.38 6.47c-0.36 0-0.65 0.3-0.65 0.65 0 0.36 0.29 0.65 0.65 0.65h5.25c0.35 0 0.65-0.29 0.65-0.65 0-0.35-0.3-0.65-0.65-0.65H5.38Z",
    "M4.73 9.5c0-0.36 0.29-0.65 0.65-0.65h5.25c0.35 0 0.65 0.3 0.65 0.65 0 0.36-0.3 0.65-0.65 0.65H5.38c-0.36 0-0.65-0.3-0.65-0.65Z",
    "M5.38 11.22c-0.36 0-0.65 0.3-0.65 0.65 0 0.36 0.29 0.66 0.65 0.66h3.37c0.36 0 0.65-0.3 0.65-0.65 0-0.36-0.3-0.66-0.65-0.66H5.38Z",
    "M6.17 0.85h3.66c0.53 0 0.98 0 1.34 0.03 0.37 0.03 0.71 0.1 1.03 0.26 0.5 0.25 0.9 0.66 1.16 1.16 0.16 0.32 0.23 0.66 0.26 1.03 0.03 0.36 0.03 0.8 0.03 1.34v6.66c0 0.53 0 0.98-0.03 1.34-0.03 0.37-0.1 0.71-0.26 1.03-0.25 0.5-0.66 0.9-1.16 1.16-0.32 0.16-0.66 0.23-1.03 0.26-0.36 0.03-0.8 0.03-1.34 0.03H6.17c-0.53 0-0.98 0-1.34-0.03-0.37-0.03-0.71-0.1-1.03-0.26-0.5-0.25-0.9-0.66-1.16-1.16-0.16-0.32-0.23-0.66-0.26-1.03-0.03-0.36-0.03-0.8-0.03-1.34V4.67c0-0.53 0-0.98 0.03-1.34 0.03-0.37 0.1-0.71 0.26-1.03C2.89 1.8 3.3 1.4 3.8 1.14 4.12 0.98 4.46 0.9 4.83 0.88c0.36-0.03 0.8-0.03 1.34-0.03ZM4.94 2.18C4.64 2.2 4.49 2.24 4.39 2.3c-0.26 0.13-0.46 0.33-0.6 0.59-0.05 0.1-0.1 0.26-0.11 0.55L3.66 3.85h8.68c0-0.16 0-0.29-0.02-0.41-0.02-0.3-0.06-0.45-0.12-0.55-0.13-0.26-0.33-0.46-0.59-0.6-0.1-0.05-0.26-0.1-0.55-0.11-0.3-0.03-0.69-0.03-1.26-0.03H6.2c-0.57 0-0.96 0-1.26 0.03ZM3.65 11.3c0 0.57 0 0.96 0.03 1.26 0.02 0.3 0.06 0.45 0.12 0.55 0.13 0.26 0.33 0.46 0.59 0.6 0.1 0.05 0.26 0.1 0.55 0.11 0.3 0.03 0.69 0.03 1.26 0.03h3.6c0.57 0 0.96 0 1.26-0.03 0.3-0.02 0.45-0.06 0.55-0.12 0.26-0.13 0.46-0.33 0.6-0.59 0.05-0.1 0.1-0.26 0.11-0.55 0.03-0.3 0.03-0.69 0.03-1.26V5.15h-8.7v6.15Z",
  ],
};

/** `symbol_note_24` — Signal's MEDIUM fallback (32dp up to 80dp). */
const NOTE_MEDIUM_24: NoteStrip = {
  viewBox: "0 0 24 24",
  paths: [
    "M8 9.88c-0.48 0-0.88 0.39-0.88 0.87s0.4 0.88 0.88 0.88h8c0.48 0 0.88-0.4 0.88-0.88S16.48 9.87 16 9.87H8Z",
    "M7.13 14.25c0-0.48 0.39-0.88 0.87-0.88h8c0.48 0 0.88 0.4 0.88 0.88s-0.4 0.88-0.88 0.88H8c-0.48 0-0.88-0.4-0.88-0.88Z",
    "M8 16.88c-0.48 0-0.88 0.39-0.88 0.87s0.4 0.88 0.88 0.88h5c0.48 0 0.88-0.4 0.88-0.88s-0.4-0.88-0.88-0.88H8Z",
    "M9.26 1.63h5.48c0.8 0 1.47 0 2 0.04 0.56 0.04 1.05 0.14 1.52 0.38 0.73 0.37 1.32 0.96 1.7 1.7 0.23 0.46 0.33 0.95 0.37 1.5 0.05 0.54 0.05 1.2 0.05 2.01v9.48c0 0.8 0 1.47-0.05 2-0.04 0.56-0.14 1.05-0.38 1.52-0.37 0.73-0.96 1.32-1.7 1.7-0.46 0.23-0.95 0.33-1.5 0.37-0.54 0.05-1.2 0.05-2.01 0.05H9.26c-0.8 0-1.47 0-2-0.05C6.7 22.3 6.2 22.2 5.74 21.95c-0.73-0.37-1.32-0.96-1.7-1.7-0.23-0.46-0.33-0.95-0.37-1.5-0.05-0.54-0.05-1.2-0.04-2.01V7.26c0-0.8 0-1.47 0.04-2C3.7 4.7 3.8 4.2 4.05 3.74 4.42 3.01 5 2.42 5.75 2.04 6.2 1.82 6.7 1.72 7.24 1.68c0.54-0.05 1.2-0.05 2.01-0.04ZM7.4 3.4c-0.45 0.04-0.69 0.1-0.86 0.2C6.14 3.8 5.8 4.14 5.6 4.54 5.5 4.7 5.45 4.95 5.4 5.4L5.38 6.12h13.24c0-0.27-0.02-0.51-0.03-0.72-0.04-0.45-0.1-0.69-0.2-0.86-0.2-0.4-0.53-0.73-0.93-0.93-0.17-0.1-0.41-0.16-0.86-0.2-0.46-0.03-1.05-0.04-1.9-0.04H9.3c-0.85 0-1.44 0-1.9 0.04ZM5.37 16.7c0 0.85 0 1.44 0.04 1.9 0.04 0.45 0.1 0.69 0.2 0.86 0.2 0.4 0.53 0.73 0.93 0.93 0.17 0.1 0.41 0.16 0.86 0.2 0.46 0.03 1.05 0.04 1.9 0.04h5.4c0.85 0 1.44 0 1.9-0.04 0.45-0.04 0.69-0.1 0.86-0.2 0.4-0.2 0.73-0.53 0.93-0.93 0.1-0.17 0.16-0.41 0.2-0.86 0.03-0.46 0.04-1.05 0.04-1.9V7.88H5.38v8.82Z",
  ],
};

/** `symbol_note_display_bold_40` — Signal's LARGE fallback (80dp and up). */
const NOTE_DISPLAY_40: NoteStrip = {
  viewBox: "0 0 40 40",
  paths: [
    "M12.5 16.75c-0.69 0-1.25 0.56-1.25 1.25s0.56 1.25 1.25 1.25h15c0.69 0 1.25-0.56 1.25-1.25s-0.56-1.25-1.25-1.25h-15Z",
    "M11.25 24c0-0.69 0.56-1.25 1.25-1.25h15c0.69 0 1.25 0.56 1.25 1.25s-0.56 1.25-1.25 1.25h-15c-0.69 0-1.25-0.56-1.25-1.25Z",
    "M12.5 28.75c-0.69 0-1.25 0.56-1.25 1.25s0.56 1.25 1.25 1.25h10c0.69 0 1.25-0.56 1.25-1.25s-0.56-1.25-1.25-1.25h-10Z",
    "M13.85 2.75h12.3c1.08 0 1.96 0 2.68 0.06 0.74 0.06 1.42 0.19 2.05 0.51 1 0.5 1.8 1.3 2.3 2.3 0.32 0.63 0.45 1.3 0.51 2.05 0.06 0.72 0.06 1.6 0.06 2.68v19.3c0 1.08 0 1.96-0.06 2.68-0.06 0.74-0.19 1.42-0.51 2.05-0.5 1-1.3 1.8-2.3 2.3-0.63 0.32-1.3 0.45-2.05 0.51-0.72 0.06-1.6 0.06-2.68 0.06h-12.3c-1.08 0-1.96 0-2.68-0.06-0.74-0.06-1.42-0.19-2.05-0.51-1-0.5-1.8-1.3-2.3-2.3-0.32-0.63-0.45-1.3-0.51-2.05-0.06-0.72-0.06-1.6-0.06-2.68v-19.3c0-1.08 0-1.96 0.06-2.68 0.06-0.74 0.19-1.42 0.51-2.05 0.5-1 1.3-1.8 2.3-2.3 0.63-0.32 1.3-0.45 2.05-0.51 0.72-0.06 1.6-0.06 2.68-0.06ZM11.37 5.3c-0.59 0.05-0.9 0.14-1.12 0.25-0.52 0.26-0.94 0.68-1.2 1.2-0.11 0.22-0.2 0.53-0.25 1.12-0.05 0.6-0.05 1.39-0.05 2.53v0.35h22.5V10.4c0-1.14 0-1.92-0.05-2.53-0.05-0.59-0.14-0.9-0.25-1.12-0.26-0.52-0.68-0.94-1.2-1.2-0.22-0.11-0.53-0.2-1.12-0.25-0.6-0.05-1.39-0.05-2.53-0.05H13.9c-1.14 0-1.92 0-2.53 0.05ZM8.75 29.6c0 1.14 0 1.92 0.05 2.53 0.05 0.59 0.14 0.9 0.25 1.12 0.26 0.52 0.68 0.94 1.2 1.2 0.22 0.11 0.53 0.2 1.12 0.25 0.6 0.05 1.39 0.05 2.53 0.05h12.2c1.14 0 1.92 0 2.53-0.05 0.59-0.05 0.9-0.14 1.12-0.25 0.52-0.26 0.94-0.68 1.2-1.2 0.11-0.22 0.2-0.53 0.25-1.12 0.05-0.6 0.05-1.39 0.05-2.53V13.25H8.75V29.6Z",
  ],
};

/**
 * The strip Signal would draw at `sizePx`. The thresholds are its own, in dp;
 * this app's CSS pixel is the same unit its Tailwind sizes are written in, so
 * the boundaries land in the same places relative to the artwork.
 */
export function noteStripFor(sizePx: number): NoteStrip {
  if (sizePx >= 80) return NOTE_DISPLAY_40;
  if (sizePx < 32) return NOTE_COMPACT_16;
  return NOTE_MEDIUM_24;
}

/**
 * The bare notepad glyph, sized by whatever class the caller passes. `sizePx`
 * only picks which of Signal's three strips is drawn — it sets no dimensions.
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
  const strip = noteStripFor(sizePx);
  return (
    <svg viewBox={strip.viewBox} fill="currentColor" aria-hidden className={className} style={style}>
      {strip.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * The Note to Self avatar: the glyph on a filled circle, in place of the
 * viewer's own profile picture. `sizePx` must match the rendered size the
 * `className` sets — it is what selects Signal's strip for that size.
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
