import { useEffect, useRef } from "react";

/**
 * The invite's living backdrop: a sonar sweep drawn in text.
 *
 * A sibling of the landing page's {@link AsciiSea} — same idea of a monospace
 * field whose glyphs are picked by a wave height, same two registered layers,
 * same deliberately-low redraw cadence — but a different sea. The landing
 * page's ocean is a horizontal swell with perspective running top to bottom;
 * this one is RADIAL, rings travelling outward from the top centre, which is
 * where the community's icon sits. The invite reads as a ping going out from
 * the community rather than a horizon behind it.
 *
 * The swell is tinted with the COMMUNITY'S own hue (the same djb2 derivation
 * that paints its fallback artwork), so two invites open onto two different
 * seas, and the crests stay on the cyan `--accent2` so they contrast with the
 * rose the buttons use rather than competing with it.
 *
 * Masked to fade in partway down: the top of the pane is dense with the
 * banner, icon and name, and the point of this is to fill the quiet space
 * BELOW the content, not to sit behind the text.
 *
 * No React state, no canvas: rows are built once per resize and only their
 * `textContent` changes.
 */

/** Trough to crest. The doubled low entries bias the field toward calm. */
const SWELL_RAMP = "  ..::--~~";
/** The ping itself, standing above the `~` of the ramp. */
const CREST_GLYPH = "*";
/** Normalized height above which a cell becomes a ping instead of swell. */
const CREST_THRESHOLD = 0.9;
/** Redraw cadence. Deliberately not 60 — a terminal doesn't animate smoothly. */
const FPS = 12;

export function InviteTide({ hue, className = "" }: { hue: number; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Two stacked full-bleed layers, sharing one grid and registering exactly.
    // A cell belongs to one or the other, never both.
    const swellLayer = document.createElement("div");
    const crestLayer = document.createElement("div");
    for (const layer of [swellLayer, crestLayer]) {
      layer.style.cssText = "position:absolute;inset:0;";
      host.appendChild(layer);
    }

    // A hidden character to measure the cell box in the field's own font and
    // size, so the grid stays exact if either changes — and so the rings come
    // out round, which needs the cell's width/height ratio.
    const probe = document.createElement("div");
    probe.textContent = "0";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;top:0;left:0;";
    host.appendChild(probe);

    let swellRows: HTMLDivElement[] = [];
    let crestRows: HTMLDivElement[] = [];
    let cols = 0;
    let rowCount = 0;
    let aspect = 0.6;

    const build = () => {
      const cell = probe.getBoundingClientRect();
      const cw = cell.width || 8;
      const chh = cell.height || 14;
      // A character cell is far taller than it is wide, so a ring measured in
      // grid steps would come out as a tall ellipse. Scaling x by the cell's
      // aspect is what makes the ping circular on screen.
      aspect = cw / chh;
      const next = Math.max(8, Math.ceil(host.clientWidth / cw) + 2);
      const nextRows = Math.max(4, Math.ceil(host.clientHeight / chh));
      if (next === cols && nextRows === rowCount) return;
      cols = next;
      rowCount = nextRows;

      swellLayer.replaceChildren();
      crestLayer.replaceChildren();
      swellRows = [];
      crestRows = [];
      for (let y = 0; y < rowCount; y++) {
        // Opacity grows with distance down the pane, so the field is faintest
        // where the copy is and strongest in the space below it.
        const near = y / Math.max(rowCount - 1, 1);
        const swell = document.createElement("div");
        swell.style.color = `hsl(${hue} 70% 62% / ${(0.05 + 0.24 * near).toFixed(3)})`;
        swellLayer.appendChild(swell);
        swellRows.push(swell);
        const crest = document.createElement("div");
        crest.style.color = `hsl(var(--accent2) / ${(0.04 + 0.3 * near).toFixed(3)})`;
        crestLayer.appendChild(crest);
        crestRows.push(crest);
      }
    };

    /** Render the character grid at a given time. */
    const paint = (t: number) => {
      const cx = cols / 2;
      for (let y = 0; y < rowCount; y++) {
        const near = y / Math.max(rowCount - 1, 1);
        const amp = 0.35 + 0.65 * near;
        let swell = "";
        let crest = "";
        for (let x = 0; x < cols; x++) {
          const dx = (x - cx) * aspect;
          const d = Math.sqrt(dx * dx + y * y);
          // One ring travelling outward, one slow counter-ring, and a lateral
          // drift so the field never resolves into a plain bullseye.
          const h =
            Math.sin(d * 0.42 - t * 1.5) +
            0.55 * Math.sin(d * 0.16 + t * 0.6) +
            0.4 * Math.sin(x * 0.09 + t * 0.35 + y * 0.12);
          // h ∈ [-1.95, 1.95] → n ∈ [0, 1], centred on 0.5 and spread by `amp`.
          const n = 0.5 + (h / 2) * amp * 0.5;
          if (n > CREST_THRESHOLD) {
            crest += CREST_GLYPH;
            swell += " ";
          } else {
            crest += " ";
            swell += SWELL_RAMP[Math.round(n * (SWELL_RAMP.length - 1))];
          }
        }
        swellRows[y].textContent = swell;
        crestRows[y].textContent = crest;
      }
    };

    let released = false;
    const remeasure = () => {
      if (released) return;
      build();
      if (reduced) paint(0);
    };

    const observer = new ResizeObserver(remeasure);
    observer.observe(host);
    build();

    // Re-measure once font loading settles: a face swapping in changes the
    // advance width WITHOUT resizing the host, so the observer never fires and
    // the grid would keep a column count sized for a font it isn't drawn in.
    document.fonts?.ready.then(remeasure).catch(() => {});

    if (reduced) {
      // Still water: one frame at the resting phase, drawn once.
      paint(0);
      return () => {
        released = true;
        observer.disconnect();
        host.replaceChildren();
      };
    }

    const frame = 1000 / FPS;
    const start = performance.now();
    let last = 0;
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < frame) return;
      last = now;
      paint((now - start) / 1000);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      released = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      host.replaceChildren();
    };
  }, [hue]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{
        // Absent below the fold of the content, present under the empty space.
        maskImage: "linear-gradient(to bottom, transparent 30%, black 70%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 30%, black 70%)",
        // Fence the repaints inside this box: every frame rewrites ~80 text
        // nodes, and without containment the browser weighs that against the
        // whole document each time.
        contain: "layout paint",
      }}
      className={`pointer-events-none absolute inset-0 select-none overflow-hidden font-mono text-[0.8125rem] leading-none [white-space:pre] ${className}`}
    />
  );
}

export default InviteTide;
