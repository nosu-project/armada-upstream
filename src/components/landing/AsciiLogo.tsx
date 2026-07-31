/**
 * ASCII renditions of the marks belonging to the projects Armada leans on.
 *
 * The page is drawn on a sea of characters, so its emblems are too: a crisp
 * vector logo would read as a foreign object pasted over the grid.
 *
 * Each is a conversion of the project's real artwork, squashed to 60% height
 * (a monospace cell is ~0.6 as wide as it is tall) and sampled at 15x9 through
 * a three-level ramp, so the proportions are genuine. Colors are each
 * project's own, lightened where the source assumed a white background.
 */

/** Concentric rings, the outer one open on the right. Source: mint #59FCB3. */
const CONCORD = [
  "   .#######    ",
  "  ##.     .    ",
  " #. .#####. .# ",
  "## .#.   .#. ##",
  "#. ##     ## .#",
  "## .#.   .#. ##",
  " #. .#####. .# ",
  "  ##.     .    ",
  "   .#######    ",
].join("\n");

/** Two branches converging into a trunk. Source: purple #9333EA. */
const NGIT = [
  " ###      ###  ",
  " ###      ###  ",
  "  #.  ..  .#   ",
  "  #   ##   #   ",
  "  ..  ..  ..   ",
  "   .. .. ..    ",
  "     .##.      ",
  "      ##       ",
  "      ..       ",
].join("\n");

/** Four nodes wired into a graph. Source: blue #0482D8. */
const SOAPBOX = [
  "         .#### ",
  "  .##.   ######",
  "  ####...######",
  "  .##.    .#.. ",
  "   .       #   ",
  " ..#.    .##.  ",
  "######...####. ",
  "######   .##.  ",
  " ####.         ",
].join("\n");

/**
 * Nostr's ostrich, in violet.
 *
 * The one mark here that is drawn rather than converted: Nostr has no single
 * official artwork to sample, so there was nothing to be faithful *to*. Kept
 * to the same 15x9 cell as the converted marks so the set still reads as one
 * family.
 */
const OSTRICH = [
  "         __    ",
  "        (o_)   ",
  "         \\     ",
  "          \\    ",
  "   .-----. \\   ",
  "  (########)   ",
  "   '--.--.-'   ",
  "      |  |     ",
  "     _|  |_    ",
].join("\n");

/** A bolt doubling as a download arrow. Source: white on navy #1E3A5F. */
const ZAPSTORE = [
  "      .#       ",
  "       ##      ",
  "       ###     ",
  "   .#######.   ",
  "    .###...    ",
  "     .##.      ",
  "      .##.     ",
  "      ####     ",
  "       .#.     ",
].join("\n");

export const ASCII_LOGOS = {
  concord: { art: CONCORD, color: "#59FCB3", label: "Concord protocol" },
  nostr: { art: OSTRICH, color: "#C084FC", label: "Nostr" },
  ngit: { art: NGIT, color: "#A855F7", label: "ngit" },
  soapbox: { art: SOAPBOX, color: "#2E9BE8", label: "Soapbox" },
  zapstore: { art: ZAPSTORE, color: "#E8EDF2", label: "Zapstore" },
} as const;

export function AsciiLogo({
  name,
  className = "",
}: {
  name: keyof typeof ASCII_LOGOS;
  className?: string;
}) {
  const { art, color, label } = ASCII_LOGOS[name];
  return (
    <pre
      role="img"
      aria-label={label}
      // `leading-[0.95]` closes the gap between rows so the blocks read as a
      // filled shape rather than as stacked lines of text.
      className={`shrink-0 select-none font-mono text-[0.5rem] leading-[0.95] ${className}`}
      style={{ color }}
    >
      {art}
    </pre>
  );
}
