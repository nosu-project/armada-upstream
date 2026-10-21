import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { pixelRects } from "./pixelArt";

/**
 * A Kingdom Hearts style menu: capsules trailing light out to either side, the
 * chosen one lit in the theme's primary colour with a pointing glove beside it.
 * Fades in after `delay` seconds; hidden until then, so it can't be clicked.
 * Then the arrow keys move the glove from anywhere on the page, and Enter or
 * Space chooses.
 */

export type GameOverMenuItem = { label: ReactNode } & ({ href: string } | { onSelect: () => void });

const GLOVE = [
  "........GGG........",
  ".......GWWWGGGGGGG.",
  "......GWWWWWWWWWWWG",
  "GGGG.GWWWWWGGGGGGG.",
  "GWWWGWWWWWWWWWG....",
  "GWWWGWWWWWWGGG.....",
  "GWWWGWWWWWWWWWG....",
  "GGGG.GWWWWWWGG.....",
  "......GGGGGGG......",
];
const GLOVE_RECTS = pixelRects(GLOVE, { W: "#ffffff", G: "#8f88a8" });

const LIT = "hsl(var(--primary))";
const UNLIT = "hsl(var(--accent2, 180 90% 55%))";

export function GameOverMenu({ items, delay }: { items: GameOverMenuItem[]; delay: number }) {
  const [selected, setSelected] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const count = items.length;

  useEffect(() => {
    let ready = false;
    const timer = setTimeout(() => {
      ready = true;
      refs.current[selectedRef.current]?.focus({ preventScroll: true });
    }, delay * 1000);

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!ready || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (step) {
        e.preventDefault();
        const next = (selectedRef.current + step + count) % count;
        setSelected(next);
        refs.current[next]?.focus({ preventScroll: true });
      } else if ((e.key === "Enter" || e.key === " ") && !refs.current.includes(document.activeElement as HTMLElement)) {
        // A focused item activates itself natively.
        e.preventDefault();
        refs.current[selectedRef.current]?.click();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [delay, count]);

  return (
    <div
      className="relative mt-6 flex w-[min(15rem,64vw)] flex-col gap-3"
      style={{ animation: `armada-gameover-menu 0.8s ease-out ${delay.toFixed(3)}s both` }}
    >
      <style>{`
        @keyframes armada-gameover-menu {
          from { opacity: 0; visibility: hidden; }
          to   { opacity: 1; visibility: visible; }
        }
        @keyframes armada-gameover-glove {
          0%, 100% { transform: translate(-100%, -50%); }
          50%      { transform: translate(calc(-100% - 4px), -50%); }
        }
      `}</style>
      {items.map((item, i) => {
        const lit = i === selected;
        const color = lit ? LIT : UNLIT;
        const trail = (side: "left" | "right"): CSSProperties => ({
          background: `linear-gradient(to ${side}, ${color}, transparent)`,
          boxShadow: lit ? `0 0 6px ${color}` : undefined,
          opacity: lit ? 1 : 0.6,
        });
        const capsule = {
          ref: (el: HTMLElement | null) => { refs.current[i] = el; },
          onPointerEnter: () => setSelected(i),
          onFocus: () => setSelected(i),
          className:
            "relative block w-full rounded-full border-2 bg-black/70 px-8 py-1.5 text-center text-base font-semibold tracking-wide text-white outline-none transition-[border-color,box-shadow] duration-150 touch:py-2.5",
          style: {
            borderColor: color,
            boxShadow: lit ? `0 0 12px ${color}, inset 0 0 10px color-mix(in srgb, ${color} 45%, transparent)` : undefined,
          },
        };
        const orb = lit && (
          <span
            aria-hidden="true"
            className="absolute right-3 top-1/2 size-2.5 -translate-y-1/2 rounded-full"
            style={{
              background: "radial-gradient(circle at 35% 35%, #fff3c4, #ffb347 55%, #e0631e)",
              boxShadow: "0 0 8px #ffb347",
            }}
          />
        );

        return (
          <div key={i} className="relative">
            <span aria-hidden="true" className="absolute right-full top-1/2 h-px w-[45vw] max-w-40 -translate-y-1/2" style={trail("left")} />
            <span aria-hidden="true" className="absolute left-full top-1/2 h-px w-[45vw] max-w-40 -translate-y-1/2" style={trail("right")} />
            {"href" in item ? (
              <a {...capsule} href={item.href} target="_blank" rel="noopener noreferrer">
                {item.label}
                {orb}
              </a>
            ) : (
              <button {...capsule} type="button" onClick={item.onSelect}>
                {item.label}
                {orb}
              </button>
            )}
            {lit && (
              <svg
                viewBox={`0 0 ${GLOVE[0].length} ${GLOVE.length}`}
                shapeRendering="crispEdges"
                aria-hidden="true"
                className="pointer-events-none absolute -left-1 top-1/2 h-auto w-9"
                style={{ transform: "translate(-100%, -50%)", animation: "armada-gameover-glove 0.9s ease-in-out infinite" }}
              >
                {GLOVE_RECTS}
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}
