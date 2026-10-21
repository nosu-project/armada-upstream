import type { CSSProperties } from "react";

import { pixelRects } from "./pixelArt";
import { WRECK_RISEN } from "./ArmadaWreck";

/**
 * A dove with an olive branch that flies down from the top of the page and
 * lands on the left of the wreck's debris once the title has risen. It faces
 * right, so its path only ever moves right. Place inside the
 * element holding {@link ArmadaWreck}; it positions itself over the debris.
 * Static styles are the perched end state, for `prefers-reduced-motion`.
 */

const FRAMES = {
  up: [
    "..........GW",
    "..........GWW",
    "...........GWW",
    "...........GWWW",
    "............GWWW...WWW...L...L",
    "............GWWWW.WWKWBSSSL.LD",
    "...G........WWWWWWWWWWB..DSS.L",
    "...GGG...WWWWWWWWWWWW.....L.SD",
    "....GGGWWWWWWWWWWWWW........DL",
    ".....GGGGWWWWWWWWW",
    ".......GGGG",
    ".",
    ".",
    ".",
    ".",
    ".",
  ],
  down: [
    ".",
    ".",
    ".",
    ".",
    "...................WWW...L...L",
    "..................WWKWBSSSL.LD",
    "...G.......WWWWWWWWWWB...DSS.L",
    "...GGG...WWWWWWWWWWWW.....L.SD",
    "....GGGWWWWWWWWWWWWW........DL",
    ".....GGGGWWWWGWWWWWW",
    ".......GGGG..GWWWW",
    ".............GWWW",
    "..............GWW",
    "..............GW",
    ".",
    ".",
  ],
  perch: [
    ".",
    ".",
    "...................WWW...L...L",
    "..................WWKWBSSSL.LD",
    "..................WWWWB..DSS.L",
    ".................WWWW.....L.SD",
    "...GG..........WWWWWW.......DL",
    "....GGG....WWWWWWWWWW",
    ".....GGGWWWWWWWWWWWWW",
    "......GGGGGGWWWWWWWW",
    "........GGGGGGWWWWW",
    "...........GGGWWWW",
    "..............F.F",
    ".............FF.FF",
    ".",
    ".",
  ],
} as const;

const PALETTE: Record<string, string> = {
  W: "#fffbe8",
  G: "#c4bdd8",
  K: "#1d1726",
  B: "#d9a3ad",
  F: "#e0788a",
  S: "#8a6a34",
  L: "#86c94f",
  D: "#4f8f2f",
};

const WIDTH = 30;
const HEIGHT = 16;

const FLY_START = WRECK_RISEN + 0.8;
const FLY = 2.6;
const FLAP = 0.28;
/** Seconds from mount until the dove has landed. */
export const DOVE_LANDED = FLY_START + FLY;

const anim = (name: string, dur: number, delay: number, ease = "linear", count: number | "infinite" = 1) =>
  `${name} ${dur}s ${ease} ${delay.toFixed(3)}s ${count} both`;

const UP = pixelRects(FRAMES.up, PALETTE);
const DOWN = pixelRects(FRAMES.down, PALETTE);
const PERCH = pixelRects(FRAMES.perch, PALETTE);

export function WreckDove() {
  const wing = (offset: number): CSSProperties => ({
    animation: anim("armada-dove-wing", FLAP, FLY_START + offset, "steps(1, end)", "infinite"),
  });
  // The flight frames and the perched one swap in the same instant.
  const swap = (name: string): CSSProperties => ({ animation: anim(name, 0.01, DOVE_LANDED) });

  return (
    <div
      aria-hidden="true"
      // Feet (column 15, row 14 of the sprite) on the left of the debris.
      className="pointer-events-none absolute left-[28%] top-[85%] z-10 w-[26%] -translate-x-1/2 -translate-y-[87%]"
    >
      <style>{`
        @keyframes armada-dove-fly-x {
          from { transform: translateX(-50vw); }
        }
        @keyframes armada-dove-fly-y {
          from { transform: translateY(-110vh); }
        }
        @keyframes armada-dove-wing {
          0%   { opacity: 1; }
          50%  { opacity: 0; }
          100% { opacity: 0; }
        }
        @keyframes armada-dove-perch {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes armada-dove-flight {
          from { opacity: 1; }
          to   { opacity: 0; }
        }
      `}</style>
      {/* One easing per axis, so the path curves without a keyframe to slow through. Neither comes to rest before touchdown, or the dove hovers. */}
      <div style={{ animation: anim("armada-dove-fly-x", FLY, FLY_START, "cubic-bezier(0.3, 0.4, 0.6, 0.85)") }}>
        <div style={{ animation: anim("armada-dove-fly-y", FLY, FLY_START, "cubic-bezier(0.25, 0.55, 0.55, 0.85)") }}>
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} shapeRendering="crispEdges" className="block h-auto w-full overflow-visible">
            <g style={{ opacity: 0, ...swap("armada-dove-flight") }}>
              <g style={wing(0)}>{UP}</g>
              <g style={wing(-FLAP / 2)}>{DOWN}</g>
            </g>
            <g style={swap("armada-dove-perch")}>{PERCH}</g>
          </svg>
        </div>
      </div>
    </div>
  );
}
