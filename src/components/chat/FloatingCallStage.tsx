import { Expand, GripHorizontal, Maximize2, Shrink, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useIsDesktop } from "@/hooks/useIsDesktop";
import { cn } from "@/lib/utils";

const EDGE_MARGIN = 12;
const POSITION_KEY = "armada:floating-call:pos";
const SIZE_KEY = "armada:floating-call:width";

/**
 * Width limits (px), the single resizable dimension (media is 16:9 of width).
 * The effective max also fits the viewport in both axes — see `clampWidth`.
 */
const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 320;
const MAX_WIDTH_CAP = 960;

const BODY_RATIO = 9 / 16;
/**
 * Conservative chrome estimates, used only to clamp WIDTH against viewport
 * height. Position clamping uses the real measured height.
 */
const HEADER_H = 34;
const CONTROLS_H = 44;
const CHROME_H = HEADER_H + CONTROLS_H;

interface Point {
  x: number;
  y: number;
}

function estPanelHeight(width: number): number {
  return CHROME_H + width * BODY_RATIO;
}

function loadPosition(): Point | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Point).x === "number" &&
      typeof (parsed as Point).y === "number"
    ) {
      return { x: (parsed as Point).x, y: (parsed as Point).y };
    }
  } catch {
    // Ignore malformed/blocked storage.
  }
  return null;
}

function savePosition(p: Point): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(p));
  } catch {
    // Ignore quota/private-mode failures.
  }
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    if (Number.isFinite(n)) return n;
  } catch {
    // Ignore malformed/blocked storage.
  }
  return DEFAULT_WIDTH;
}

function saveWidth(w: number): void {
  try {
    localStorage.setItem(SIZE_KEY, String(Math.round(w)));
  } catch {
    // Ignore quota/private-mode failures.
  }
}

/** Clamp width to [MIN_WIDTH, max], max bounded by MAX_WIDTH_CAP and the viewport in both axes. */
function clampWidth(width: number): number {
  const availW = window.innerWidth - EDGE_MARGIN * 2;
  const availH = window.innerHeight - EDGE_MARGIN * 2;
  const maxByHeight = (availH - CHROME_H) / BODY_RATIO;
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH_CAP, availW, maxByHeight));
  return Math.min(Math.max(width, MIN_WIDTH), max);
}

/** `height` is the real measured height when available, else the estimate. */
function clampToViewport(p: Point, width: number, height: number): Point {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
  return {
    x: Math.min(Math.max(p.x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(p.y, EDGE_MARGIN), maxY),
  };
}

function defaultPosition(width: number, height: number): Point {
  return {
    x: Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN),
    y: Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN),
  };
}

/**
 * Desktop floating call window: a draggable (title area) and resizable
 * (top-left handle, bottom-right anchored) panel whose body is the floating
 * stage host. CallProvider reparents the one persistent `CallStage` into it,
 * so there's no duplicate subscription. Position and width persist and are
 * clamped to the viewport. Below the `sidebar` breakpoint it registers nothing
 * (MobileCallPreview takes over).
 */
export function FloatingCallStage({
  registerSlot,
  onExpand,
  onHide,
}: {
  registerSlot: (el: HTMLElement | null, variant?: "desktop" | "mobile") => void;
  onExpand?: () => void;
  onHide: () => void;
}) {
  const isDesktop = useIsDesktop();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [width, setWidth] = useState<number>(() => loadWidth());
  // Null until first placement; rendered invisibly for that frame.
  const [pos, setPos] = useState<Point | null>(null);
  const [gesture, setGesture] = useState<null | "drag" | "resize">(null);
  // Gates the entry animation to first appearance, so a gesture end can't replay it.
  const [entered, setEntered] = useState(false);

  const active = useRef<
    | { kind: "drag"; pointerId: number; offsetX: number; offsetY: number }
    | { kind: "resize"; pointerId: number; anchorRight: number; anchorBottom: number }
    | null
  >(null);
  // Set once a gesture moved, so the trailing click is swallowed.
  const moved = useRef(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const posRef = useRef<Point | null>(pos);
  posRef.current = pos;

  // Clearing on unmount/mobile parks the stage off-DOM rather than inside a hidden
  // panel (a display:none ancestor pauses video).
  useEffect(() => {
    if (!isDesktop) {
      registerSlot(null, "desktop");
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    registerSlot(el, "desktop");
    return () => registerSlot(null, "desktop");
  }, [isDesktop, registerSlot]);

  // Height MUST come from the estimate: the stage host is reparented a commit
  // later (passive effect), so measuring now sees a header-only panel.
  useLayoutEffect(() => {
    if (!isDesktop) return;
    const w = clampWidth(loadWidth());
    setWidth(w);
    const height = estPanelHeight(w);
    const saved = loadPosition();
    setPos(clampToViewport(saved ?? defaultPosition(w, height), w, height));
  }, [isDesktop]);

  // Timeout outlasts the 200ms animation.
  useEffect(() => {
    if (!pos || entered) return;
    const t = setTimeout(() => setEntered(true), 250);
    return () => clearTimeout(t);
  }, [pos, entered]);

  // Re-clamp on real size changes to correct estimate drift.
  useEffect(() => {
    if (!isDesktop) return;
    const el = panelRef.current;
    if (!el) return;
    const reclamp = () => {
      if (active.current) return;
      const height = el.offsetHeight || estPanelHeight(widthRef.current);
      setPos((cur) => (cur ? clampToViewport(cur, widthRef.current, height) : cur));
    };
    const ro = new ResizeObserver(reclamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop]);

  useEffect(() => {
    if (!isDesktop) return;
    const onResize = () => {
      if (active.current) return;
      setWidth((w) => {
        const cw = clampWidth(w);
        const el = panelRef.current;
        const height = el?.offsetHeight || estPanelHeight(cw);
        setPos((cur) => (cur ? clampToViewport(cur, cw, height) : cur));
        return cw;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isDesktop]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const a = active.current;
    if (!a || e.pointerId !== a.pointerId) return;
    moved.current = true;
    const el = panelRef.current;
    if (a.kind === "drag") {
      const height = el?.offsetHeight || estPanelHeight(widthRef.current);
      setPos(
        clampToViewport(
          { x: e.clientX - a.offsetX, y: e.clientY - a.offsetY },
          widthRef.current,
          height,
        ),
      );
    } else {
      // Width = distance from pointer to the anchored right edge; top-left is
      // recomputed from the anchor and clamped using the real measured height.
      const w = clampWidth(a.anchorRight - e.clientX);
      widthRef.current = w;
      setWidth(w);
      const height = el?.offsetHeight || estPanelHeight(w);
      setPos(
        clampToViewport({ x: a.anchorRight - w, y: a.anchorBottom - height }, w, height),
      );
    }
  }, []);

  const endGesture = useCallback(
    (e: PointerEvent) => {
      const a = active.current;
      if (!a || e.pointerId !== a.pointerId) return;
      active.current = null;
      setGesture(null);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endGesture);
      window.removeEventListener("pointercancel", endGesture);
      setPos((cur) => {
        if (cur) savePosition(cur);
        return cur;
      });
      saveWidth(widthRef.current);
      // Clear next tick so the click right after pointerup is still suppressed.
      if (moved.current) {
        setTimeout(() => {
          moved.current = false;
        }, 0);
      }
    },
    [onPointerMove],
  );

  const beginDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      active.current = {
        kind: "drag",
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      moved.current = false;
      setGesture("drag");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endGesture);
      window.addEventListener("pointercancel", endGesture);
      e.preventDefault();
      e.stopPropagation();
    },
    [onPointerMove, endGesture],
  );

  const beginResize = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const el = panelRef.current;
      const cur = posRef.current;
      if (!el || !cur) return;
      const rect = el.getBoundingClientRect();
      active.current = {
        kind: "resize",
        pointerId: e.pointerId,
        anchorRight: rect.right,
        anchorBottom: rect.bottom,
      };
      moved.current = false;
      setGesture("resize");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endGesture);
      window.addEventListener("pointercancel", endGesture);
      e.preventDefault();
      e.stopPropagation();
    },
    [onPointerMove, endGesture],
  );

  // Toggle between the effective max width and the prior width.
  const prevWidth = useRef<number | null>(null);
  const toggleExpand = useCallback(() => {
    setWidth((w) => {
      const max = clampWidth(MAX_WIDTH_CAP);
      const expanding = w < max - 1;
      const next = expanding ? max : clampWidth(prevWidth.current ?? DEFAULT_WIDTH);
      prevWidth.current = expanding ? w : null;
      widthRef.current = next;
      saveWidth(next);
      const height = estPanelHeight(next);
      setPos((cur) => (cur ? clampToViewport(cur, next, height) : cur));
      return next;
    });
  }, []);
  const atMax = width >= clampWidth(MAX_WIDTH_CAP) - 1;

  const swallowClick = useCallback((e: React.MouseEvent) => {
    if (moved.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endGesture);
      window.removeEventListener("pointercancel", endGesture);
    },
    [onPointerMove, endGesture],
  );

  if (!isDesktop) return null;

  const busy = gesture !== null;

  return (
    <div
      ref={panelRef}
      onClickCapture={swallowClick}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden select-none",
        "clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        // Position is imperative, so `left`/`top` must never tween: Tailwind's
        // `duration-200` also emits a transition with `transition-property: all`.
        "transition-none",
        // Invisible until placed, so it never flashes at the origin.
        pos ? "opacity-100" : "opacity-0 pointer-events-none",
        !entered && "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
      )}
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        width,
      }}
    >
      <div className="flex items-center gap-0.5 px-1 py-1 shrink-0 border-b border-white/10">
        {/* `touch-none` keeps touch/pen from scrolling instead of resizing. */}
        <div
          onPointerDown={beginResize}
          role="presentation"
          aria-label="Resize floating call window"
          className={cn(
            "shrink-0 flex items-center justify-center touch-none cursor-nwse-resize",
            "size-6 touch:size-8",
            "text-muted-foreground opacity-50 hover:opacity-100 hover:text-foreground transition-opacity",
            gesture === "resize" && "opacity-100 text-foreground",
          )}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M1 4L4 1" />
            <path d="M1 7.5L7.5 1" />
            <path d="M1 11L11 1" />
          </svg>
        </div>
        {/* Drag is scoped to the title area, never the handle, buttons or video body. */}
        <div
          onPointerDown={beginDrag}
          className={cn(
            "flex items-center justify-center gap-1 flex-1 min-w-0 rounded-md px-1 py-0.5 touch-none",
            gesture === "drag" ? "cursor-grabbing" : "cursor-grab",
          )}
          role="presentation"
          aria-label="Drag floating call window"
        >
          <GripHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-xs font-medium text-muted-foreground truncate">Call</span>
        </div>
        <button
          type="button"
          aria-label={atMax ? "Restore window size" : "Expand window"}
          title={atMax ? "Restore size" : "Expand"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleExpand}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
        >
          {atMax ? <Shrink className="size-4" /> : <Expand className="size-4" />}
        </button>
        {onExpand && (
          <button
            type="button"
            aria-label="Return to call"
            title="Return to call"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onExpand}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          >
            <Maximize2 className="size-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Hide floating video"
          title="Hide floating video"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onHide}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
        >
          <X className="size-4" />
        </button>
      </div>
      {/* Reparent target. Pointer events off mid-gesture so a fast drag can't click a tile. */}
      <div ref={bodyRef} className={cn("w-full", busy && "pointer-events-none")} />
    </div>
  );
}
