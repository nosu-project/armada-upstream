import { useEffect, useRef } from "react";

import { FallbackImage } from "@/components/ui/FallbackImage";

import { captureMirrors, captureUrl } from "./captures";

/**
 * The app itself, under the landing's pitch: a display and a phone floating in
 * the sea's space, showing whichever community the pitch has dealt. Every
 * screen is the real routed app on seeded data —
 * regenerate them with `e2e/landing-screenshots.spec.ts` rather than editing
 * the images, so they keep tracking the UI.
 *
 * Each device is a FLAT element with its own `perspective()` pose, and its
 * thickness is a stack of flat layers pushed back along Z under the same pose.
 * Deliberately not `transform-style: preserve-3d` with real edge faces:
 * Chrome rasterizes a plane inside a 3D rendering context at about 1x, which
 * turned the screenshots to mush on a 2x screen, while a flat element under a
 * perspective transform rasterizes at full density. With no 3D context there
 * is no depth sorting either, so paint order does it: layers back to front,
 * the screen last, the phone after the display.
 *
 * On a real pointer each device leans toward the cursor by its own amount.
 * The pointer writes two custom properties onto the stage inside one animation
 * frame and every pose reads them, so a hover is a style pass on this subtree
 * and a composite, never a React render. Nothing moves otherwise.
 *
 * Lazy and below the fold, so the landing's first frame never waits on them.
 * Under `sm` only the phone shows: a desktop capture scaled to a phone's width
 * is unreadable, and a hidden lazy `<img>` is never fetched.
 */

/** Pointer offset from the stage's centre, -0.5..0.5 on each axis. */
const STAGE_STYLE = { "--px": "0", "--py": "0" } as React.CSSProperties;

interface Pose {
  /** Resting turn and tilt, degrees. */
  ry: number;
  rx: number;
  rz: number;
  /** How far the pointer can push each, degrees per unit of offset. */
  leanY: number;
  leanX: number;
  /**
   * Viewing distance, px. The display needs the longer one: at 1600px a panel
   * that wide shrinks its back layers inward by about as much as the turn
   * pushes them out, so its edge nets to nothing — the way a wide object seen
   * up close hides its own side.
   */
  perspective: number;
  /** Body thickness in px, and how many layers draw it. */
  depth: number;
  layers: number;
}

/** Turned toward the phone, tipped back a touch. */
const DISPLAY: Pose = { ry: 16, rx: 4, rz: 0, leanY: 10, leanX: 6, perspective: 3200, depth: 30, layers: 15 };
/** Turned toward the display, with a slight roll. */
const PHONE: Pose = { ry: -24, rx: 6, rz: 3, leanY: 18, leanX: 10, perspective: 1600, depth: 26, layers: 13 };

function transformAt(p: Pose, z: number): string {
  return (
    `perspective(${p.perspective}px) rotateY(calc(${p.ry}deg + var(--px) * ${p.leanY}deg)) ` +
    `rotateX(calc(${p.rx}deg - var(--py) * ${p.leanX}deg)) rotateZ(${p.rz}deg) translateZ(${-z}px)`
  );
}

/**
 * The body's layers, back to front, each shaded a little lighter than the one
 * behind it so the edge reads as a lit metal rim rather than a flat band. Kept
 * well above the sea's own lightness: a body as dark as the background is a
 * body nobody can see. Built once
 * per device at module load, so React never sees new style objects.
 */
function bodyLayers(p: Pose, radius: number): React.CSSProperties[] {
  return Array.from({ length: p.layers }, (_, i) => {
    const t = i / (p.layers - 1); // 0 = back, 1 = just behind the screen
    return {
      transform: transformAt(p, p.depth * (1 - t)),
      borderRadius: radius,
      background: `hsl(262 10% ${14 + t * 24}%)`,
    };
  });
}

const DISPLAY_RADIUS = 12;
const PHONE_RADIUS = 30;
const DISPLAY_BODY = bodyLayers(DISPLAY, DISPLAY_RADIUS);
const PHONE_BODY = bodyLayers(PHONE, PHONE_RADIUS);
const DISPLAY_FACE = { transform: transformAt(DISPLAY, 0), borderRadius: DISPLAY_RADIUS } as React.CSSProperties;
const PHONE_FACE = { transform: transformAt(PHONE, 0), borderRadius: PHONE_RADIUS } as React.CSSProperties;

/** Shared by every layer and face: the lean eases rather than snaps. */
const MOVES = "transition-transform duration-700 ease-out motion-reduce:transition-none";

function Body({ layers }: { layers: React.CSSProperties[] }) {
  return (
    <>
      {layers.map((style, i) => (
        <div key={i} aria-hidden="true" className={`absolute inset-0 ${MOVES}`} style={style} />
      ))}
    </>
  );
}

/**
 * One device's screen: the capture for `slugs[index]`, crossfading from the
 * one before it. Only the current capture and its two neighbours are mounted,
 * so the next one is already decoded when it is dealt and the rest are never
 * fetched until they are close.
 */
function Screen({
  slugs,
  index,
  size,
  ratio,
  className,
  alt,
}: {
  slugs: readonly string[];
  index: number;
  size: "desktop" | "mobile";
  ratio: string;
  className: string;
  alt: string;
}) {
  const n = slugs.length;
  return (
    <div className={`relative w-full overflow-hidden ${ratio} ${className}`}>
      {slugs.map((slug, i) => {
        const offset = (i - index + n) % n;
        if (offset !== 0 && offset !== 1 && offset !== n - 1) return null;
        return (
          <FallbackImage
            key={slug}
            src={captureUrl(slug, size)}
            fallbacks={captureMirrors(slug, size)}
            loading="lazy"
            decoding="async"
            alt={offset === 0 ? alt : ""}
            aria-hidden={offset !== 0}
            className={`absolute inset-0 size-full transition-opacity duration-500 ease-out motion-reduce:transition-none ${
              offset === 0 ? "opacity-100" : "opacity-0"
            }`}
          />
        );
      })}
    </div>
  );
}

export function ProductShots({
  slugs,
  index,
  label,
}: {
  /** Capture slugs, as keyed in `captures.ts`. */
  slugs: readonly string[];
  /** Which capture is on screen. */
  index: number;
  /** What the current capture shows, for its alt text. */
  label: string;
}) {
  const stageRef = useRef<HTMLDivElement>(null);

  // Lean toward a real pointer. Touch has no hover to follow, and reduced
  // motion asked for the stage to hold still, so both keep the resting poses.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let rect: DOMRect | undefined;
    let x = 0;
    let y = 0;
    let raf = 0;

    const apply = () => {
      raf = 0;
      stage.style.setProperty("--px", x.toFixed(3));
      stage.style.setProperty("--py", y.toFixed(3));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    // Measured once per visit rather than per move: reading layout on every
    // pointer event is what turns a hover into a stream of forced reflows.
    const onEnter = () => {
      rect = stage.getBoundingClientRect();
    };
    const onMove = (e: PointerEvent) => {
      rect ??= stage.getBoundingClientRect();
      x = Math.max(-0.5, Math.min(0.5, (e.clientX - rect.left) / rect.width - 0.5));
      y = Math.max(-0.5, Math.min(0.5, (e.clientY - rect.top) / rect.height - 0.5));
      schedule();
    };
    const onLeave = () => {
      rect = undefined;
      x = 0;
      y = 0;
      schedule();
    };

    stage.addEventListener("pointerenter", onEnter);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerleave", onLeave);
    return () => {
      stage.removeEventListener("pointerenter", onEnter);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={stageRef} style={STAGE_STYLE} className="relative flex w-full items-center justify-center py-10">
      {/* ── Display ── */}
      <div className="relative hidden w-[74%] sm:block">
        <Body layers={DISPLAY_BODY} />
        <div
          style={DISPLAY_FACE}
          className={`relative border border-[hsl(var(--primary)/0.35)] bg-[#08060b] p-[0.9%] ${MOVES}`}
        >
          <Screen
            slugs={slugs}
            index={index}
            size="desktop"
            ratio="aspect-[2400/1520]"
            className="rounded-[6px]"
            alt={`Armada on desktop: ${label}`}
          />
        </div>
      </div>

      {/* ── Phone ── After the display, so it paints over the display's edge. */}
      <div className="relative w-60 shrink-0 sm:-ml-[5%] sm:mt-[12%] sm:w-[21%]">
        <Body layers={PHONE_BODY} />
        <div
          style={PHONE_FACE}
          className={`relative border border-[hsl(var(--accent2)/0.35)] bg-[#08060b] p-[3.5%] ${MOVES}`}
        >
          <Screen
            slugs={slugs}
            index={index}
            size="mobile"
            ratio="aspect-[1170/2532]"
            className="rounded-[24px]"
            alt={`Armada on a phone: ${label}`}
          />
        </div>
      </div>
    </div>
  );
}
