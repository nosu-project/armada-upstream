import { useEffect, useRef, type RefObject } from "react";

/**
 * The ASCII sea: the landing page's living background.
 *
 * A monospace field whose glyphs are picked by a travelling wave height, so
 * the page sits on an ocean drawn in text. Two layers share the one grid and
 * register exactly: the cyan swell (`--accent2`, glyphs from the ramp) and the
 * rose crests (`--primary`, cells over the threshold). A cell belongs to one
 * layer or the other, never both.
 *
 * Perspective runs top to bottom, with horizon rows as fine chop and
 * foreground rows as long opaque swell. Crests need high amplitude, so
 * whitecaps only ever appear near the viewer.
 *
 * At rest a band of surf shows below the splash; scrolling raises the
 * waterline and eases the wave phase forward.
 *
 * No React state, no canvas: rows are built once per resize and only their
 * `textContent` changes. Redraws at {@link FPS} rather than 60, because a
 * terminal doesn't animate smoothly and this shouldn't either.
 */

/** Trough to crest. The doubled low entries bias the sea toward calm water. */
const SWELL_RAMP = "  ..,,--~~";
/** Whitecap, standing above the `~` of the ramp. */
const CREST_GLYPH = "≈";
/** Normalized wave height above which a cell becomes a crest instead of swell. */
const CREST_THRESHOLD = 0.88;
/** Redraw cadence. Deliberately not 60 — see the note above. */
const FPS = 14;
/** Scroll distance, in viewports, over which `depth` runs 0 → 1. */
const DEPTH_SPAN = 1;
/** Depth at which the waterline begins to climb. */
const SEA_FADE_START = 0;
/** Depth by which the sea fills the viewport. */
const SEA_FADE_END = 0.5;
/**
 * Where the waterline sits at rest, as a percentage down the viewport. Only
 * the surf below this shows behind the splash, as a teaser.
 */
const TEASER_STOP = 72;
/**
 * Height of the soft horizon band above the waterline, in percent. The sea is
 * only fully opaque below `TEASER_STOP + HORIZON_FEATHER`, so these two have
 * to leave a solid band at the bottom of the splash to actually tease with.
 */
const HORIZON_FEATHER = 18;
/** How far a full descent carries the swell, in wave-phase units. */
const PHASE_TRAVEL = 2.5;

export function AsciiSea({
  scrollRef,
  className = "",
}: {
  /**
   * The scroll container the sea reacts to. Read imperatively inside the
   * animation frame — never through state, so scrolling causes no re-render.
   */
  scrollRef?: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Two stacked full-bleed layers. Row elements live inside them and are
    // rebuilt only when the grid dimensions change.
    const swellLayer = document.createElement("div");
    const crestLayer = document.createElement("div");
    for (const layer of [swellLayer, crestLayer]) {
      layer.style.cssText = "position:absolute;inset:0;";
      host.appendChild(layer);
    }

    // A hidden character to measure the cell box in the sea's *own* font and
    // size, so the grid stays exact if either changes (or if the webfont
    // arrives after first paint and the metrics shift under us).
    const probe = document.createElement("div");
    probe.textContent = "0";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;top:0;left:0;";
    host.appendChild(probe);

    let swellRows: HTMLDivElement[] = [];
    let crestRows: HTMLDivElement[] = [];
    let cols = 0;
    let rowCount = 0;

    const build = () => {
      const cell = probe.getBoundingClientRect();
      const cw = cell.width || 8;
      const chh = cell.height || 14;
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
        // `near` is 0 at the horizon and 1 in the foreground. Opacity ramps
        // with it so the sea recedes into the background at the top of the
        // viewport, where the crest and wordmark sit.
        const near = y / Math.max(rowCount - 1, 1);
        const swell = document.createElement("div");
        swell.style.color = `hsl(var(--accent2) / ${(0.07 + 0.3 * near).toFixed(3)})`;
        swellLayer.appendChild(swell);
        swellRows.push(swell);
        const crest = document.createElement("div");
        crest.style.color = `hsl(var(--primary) / ${(0.05 + 0.4 * near).toFixed(3)})`;
        crestLayer.appendChild(crest);
        crestRows.push(crest);
      }
    };

    /** How far down the deck we are, in viewports, clamped to 0…1. */
    const depthNow = () => {
      const scroller = scrollRef?.current;
      if (!scroller?.clientHeight) return 0;
      return Math.min(1, Math.max(0, scroller.scrollTop / (scroller.clientHeight * DEPTH_SPAN)));
    };

    /**
     * The reveal ramp: 0 behind the splash, 1 once the hero has cleared.
     * Smoothstepped so the sea eases up out of nothing rather than starting
     * to fade at a visible seam.
     */
    const revealAt = (depth: number) => {
      const t = Math.min(
        1,
        Math.max(0, (depth - SEA_FADE_START) / (SEA_FADE_END - SEA_FADE_START)),
      );
      return t * t * (3 - 2 * t);
    };

    /**
     * The first row the mask lets show. Everything above the waterline is
     * fully transparent, and at rest that is most of the grid — redrawing it
     * was most of what the idle landing page spent — so paint skips it. Rows
     * uncovered by scrolling are drawn on the next tick (a few rows of margin
     * keep the feathered edge from showing a blank row in between).
     */
    const firstVisibleRow = (reveal: number) =>
      Math.max(0, Math.floor(((TEASER_STOP * (1 - reveal)) / 100) * rowCount) - 3);

    /** Render the character grid at a given wave phase, from row `from` down. */
    const paint = (phase: number, from = 0) => {
      for (let y = Math.min(from, rowCount); y < rowCount; y++) {
        const near = y / Math.max(rowCount - 1, 1);
        const amp = 0.32 + 0.68 * near;
        // Wavelength grows toward the viewer: the horizon is fine chop, the
        // foreground is long ocean swell.
        const freq = 0.3 - 0.2 * near;
        let swell = "";
        let crest = "";
        for (let x = 0; x < cols; x++) {
          // Three incommensurate sines so the surface never visibly repeats.
          // The `y` terms shear each row against the one above it, which is
          // what turns a set of independent lines into a single moving
          // surface.
          const h =
            Math.sin(x * freq + phase * 0.9 + y * 0.55) +
            0.6 * Math.sin(x * freq * 2.3 - phase * 1.35 + y * 0.29) +
            0.4 * Math.sin(x * freq * 0.45 + phase * 0.5 - y * 0.17);
          // h ∈ [-2, 2] → n ∈ [0, 1], centred on 0.5 and spread by `amp`.
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

    /**
     * Raise or lower the waterline.
     *
     * The sea is never hidden: at rest a band of surf shows along the bottom
     * of the splash as a teaser, and scrolling lifts the waterline up the
     * viewport until the ocean fills it. Driven by the mask rather than by
     * opacity so the visible band always renders at full strength, instead of
     * the whole ocean sitting faint behind the mark.
     */
    const applyVeil = (reveal: number) => {
      const top = TEASER_STOP * (1 - reveal);
      const mask = `linear-gradient(to bottom, transparent ${top.toFixed(1)}%, black ${(
        top + HORIZON_FEATHER
      ).toFixed(1)}%)`;
      // `setProperty` for both spellings: the unprefixed `mask-image` is not
      // in every CSSStyleDeclaration typing, and WebKit still wants the
      // prefixed one.
      host.style.setProperty("mask-image", mask);
      host.style.setProperty("-webkit-mask-image", mask);
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

    // Re-measure once font loading has settled. The column count comes from a
    // character's advance width, and a face swapping in underneath changes
    // that width WITHOUT changing the host's size, so the ResizeObserver never
    // fires and the sea would keep a grid sized for a font it is no longer
    // drawn in (short rows, or a column of overflow past the right edge).
    // Cheap insurance: with only system fonts in the stack this resolves
    // immediately and re-measures to the same numbers.
    document.fonts?.ready.then(remeasure).catch(() => {});

    if (reduced) {
      // Still water: one frame at the resting phase, drawn once. The waves
      // never move.
      //
      // The scroll-driven waterline is kept, though: it only moves in step
      // with the user's own scrolling, so it reads as part of the page rather
      // than as animation, and without it the ocean would cover the splash
      // the design says to keep clear. The grid is already drawn, so the
      // listener only rewrites the mask.
      paint(0);
      const scroller = scrollRef?.current;
      const onScroll = () => {
        applyVeil(revealAt(depthNow()));
      };
      onScroll();
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        released = true;
        scroller?.removeEventListener("scroll", onScroll);
        observer.disconnect();
        host.replaceChildren();
      };
    }

    // Driven by a timer at the paint cadence, not a free-running rAF loop: a
    // loop at the display rate for a 14 fps effect woke the renderer 60 times
    // a second and rewrote the mask on every one of them, which on an idle
    // landing page was most of the app's CPU. Each tick still paints inside a
    // frame (rAF), and scrolling gets its own frame-aligned veil updates.
    const frame = 1000 / FPS;
    const start = performance.now();
    let lastTick = start;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    let veilRaf = 0;
    let lastReveal = -1;
    // The phase's own, lagging idea of how far down the page we are.
    let phaseDepth = depthNow();

    const veil = () => {
      const reveal = revealAt(depthNow());
      if (reveal === lastReveal) return;
      lastReveal = reveal;
      applyVeil(reveal);
    };

    const tick = (now: number) => {
      raf = 0;
      // The wave phase follows scroll only loosely. Feeding it `scrollTop`
      // directly means a flick of the wheel jumps the phase by more than a
      // wavelength between two redraws, which reads as the sea tearing rather
      // than travelling. Easing it (6% of the gap per 60 Hz frame's worth of
      // time) keeps the "sea moves as you do" cue while capping the shift.
      const depth = depthNow();
      phaseDepth += (depth - phaseDepth) * (1 - Math.pow(0.94, (now - lastTick) / (1000 / 60)));
      lastTick = now;
      veil();
      paint((now - start) / 1000 + phaseDepth * PHASE_TRAVEL, firstVisibleRow(revealAt(depth)));
      schedule();
    };

    const schedule = () => {
      if (released || timer !== undefined || raf) return;
      // A hidden page gets no frames anyway; don't keep a timer spinning for it.
      if (document.hidden) return;
      timer = setTimeout(() => {
        timer = undefined;
        raf = requestAnimationFrame(tick);
      }, frame);
    };

    // The waterline tracks scroll every frame while scrolling — stepping it at
    // the paint cadence made the horizon visibly stair-step down the viewport.
    const scroller = scrollRef?.current;
    const onScroll = () => {
      if (veilRaf) return;
      veilRaf = requestAnimationFrame(() => {
        veilRaf = 0;
        veil();
      });
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    const onVisibility = () => schedule();
    document.addEventListener("visibilitychange", onVisibility);

    veil();
    raf = requestAnimationFrame(tick);

    return () => {
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(veilRaf);
      scroller?.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      host.replaceChildren();
    };
  }, [scrollRef]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      // The resting waterline is baked in here so the very first paint (before
      // the effect's first frame) already shows the teaser band rather than a
      // full-viewport ocean behind the mark. The effect rewrites `mask-image`
      // inline from then on, which outranks this.
      style={{
        maskImage: `linear-gradient(to bottom, transparent ${TEASER_STOP}%, black ${
          TEASER_STOP + HORIZON_FEATHER
        }%)`,
        // Fence the sea's repaints inside its own box. Every redraw rewrites
        // ~80 text nodes, and without containment the browser has to consider
        // that against the whole scrolling document on each one.
        // Not `strict`: that adds size containment, and this element takes its
        // size from `inset-0` on its containing block.
        contain: "layout paint",
      }}
      className={`pointer-events-none absolute inset-0 select-none overflow-hidden font-mono text-[0.8125rem] leading-none [white-space:pre] ${className}`}
    />
  );
}
