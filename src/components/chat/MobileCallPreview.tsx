import { GripHorizontal, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useCall } from "@/hooks/useCall";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { cn } from "@/lib/utils";

const POS_KEY = "armada:mobile-call-preview:pos";
const SIZE_KEY = "armada:mobile-call-preview:width";

/** Gap kept from every viewport edge (and from the call bar). */
const EDGE_GAP = 8;
const HEADER_H = 32;
const BODY_RATIO = 9 / 16;

/** Width limits; the effective max is derived per clamp (see `clampWidth`). */
const MIN_WIDTH = 128;
const MAX_WIDTH_CAP = 460;

interface Point {
  x: number;
  y: number;
}

/**
 * The visible box the preview must stay in: `visualViewport` when available
 * (shrinks with the keyboard), minus safe areas and `callBarHeight` (which
 * already includes the bottom inset).
 */
function viewportBox(callBarHeight: number): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const vw = vv?.width ?? window.innerWidth;
  const vh = vv?.height ?? window.innerHeight;
  const offLeft = vv?.offsetLeft ?? 0;
  const offTop = vv?.offsetTop ?? 0;

  // The call bar already accounts for the BOTTOM inset.
  const cs = typeof window !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const px = (v: string | undefined) => {
    const n = v ? parseFloat(v) : 0;
    return Number.isFinite(n) ? n : 0;
  };
  const insetTop = px(cs?.getPropertyValue("--safe-area-inset-top"));
  const insetLeft = px(cs?.getPropertyValue("--safe-area-inset-left"));
  const insetRight = px(cs?.getPropertyValue("--safe-area-inset-right"));

  const left = offLeft + insetLeft + EDGE_GAP;
  const top = offTop + insetTop + EDGE_GAP;
  const width = Math.max(0, vw - insetLeft - insetRight - EDGE_GAP * 2);
  const height = Math.max(0, vh - insetTop - callBarHeight - EDGE_GAP * 2);
  return { left, top, width, height };
}

function panelHeight(width: number): number {
  return HEADER_H + width * BODY_RATIO;
}

/** Clamp width to [MIN_WIDTH, max], bounded by the box in both axes and MAX_WIDTH_CAP. */
function clampWidth(width: number, callBarHeight: number): number {
  const box = viewportBox(callBarHeight);
  const maxByWidth = box.width;
  const maxByHeight = (box.height - HEADER_H) / BODY_RATIO;
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH_CAP, maxByWidth, maxByHeight));
  return Math.min(Math.max(width, MIN_WIDTH), max);
}

function clampPos(p: Point, width: number, callBarHeight: number): Point {
  const box = viewportBox(callBarHeight);
  const h = panelHeight(width);
  const maxX = Math.max(box.left, box.left + box.width - width);
  const maxY = Math.max(box.top, box.top + box.height - h);
  return {
    x: Math.min(Math.max(p.x, box.left), maxX),
    y: Math.min(Math.max(p.y, box.top), maxY),
  };
}

function defaultPos(width: number, callBarHeight: number): Point {
  const box = viewportBox(callBarHeight);
  return {
    x: box.left + box.width - width,
    y: box.top + box.height - panelHeight(width),
  };
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    if (Number.isFinite(n)) return n;
  } catch {
    // ignore
  }
  return 260; // sensible default (~old "medium")
}

function loadPos(): Point | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
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
    // ignore
  }
  return null;
}

function savePos(p: Point) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}
function saveWidth(w: number) {
  try {
    localStorage.setItem(SIZE_KEY, String(Math.round(w)));
  } catch {
    // ignore
  }
}

/**
 * Mobile counterpart of `FloatingCallStage`: the floating stage host that
 * CallProvider reparents the persistent `CallStage` into. Draggable by the
 * title area and resizable from the top-left handle (16:9 kept), clamped to
 * the visible viewport minus safe areas and the MobileCallBar. Media controls
 * stay in MobileCallBar. Renders nothing at/above the `sidebar` breakpoint.
 */
export function MobileCallPreview({
  registerSlot,
  onExpand,
  onHide,
}: {
  registerSlot: (el: HTMLElement | null, variant?: "desktop" | "mobile") => void;
  onExpand?: () => void;
  onHide: () => void;
}) {
  const isDesktop = useIsDesktop();
  const { callBarHeight } = useCall();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Position is null until first placement (held invisible for that frame).
  const [width, setWidth] = useState<number>(() => loadWidth());
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
  const callBarHeightRef = useRef(callBarHeight);
  callBarHeightRef.current = callBarHeight;

  // Clearing on unmount/desktop parks the stage off-DOM (a display:none ancestor
  // pauses video). The "mobile" variant tells the stage to omit its control row.
  useEffect(() => {
    if (isDesktop) {
      registerSlot(null, "mobile");
      return;
    }
    const el = bodyRef.current;
    if (!el) return;
    registerSlot(el, "mobile");
    return () => registerSlot(null, "mobile");
  }, [isDesktop, registerSlot]);

  useLayoutEffect(() => {
    if (isDesktop) return;
    const w = clampWidth(loadWidth(), callBarHeightRef.current);
    setWidth(w);
    const saved = loadPos();
    setPos(clampPos(saved ?? defaultPos(w, callBarHeightRef.current), w, callBarHeightRef.current));
  }, [isDesktop]);

  // Timeout outlasts the 200ms animation.
  useEffect(() => {
    if (!pos || entered) return;
    const t = setTimeout(() => setEntered(true), 250);
    return () => clearTimeout(t);
  }, [pos, entered]);

  // Re-clamp on rotation, resize, keyboard, safe-area and call-bar changes; never
  // mid-gesture (those clamp live).
  const reclamp = useCallback(() => {
    if (active.current) return;
    setWidth((w) => {
      const cw = clampWidth(w, callBarHeightRef.current);
      setPos((cur) => (cur ? clampPos(cur, cw, callBarHeightRef.current) : cur));
      return cw;
    });
  }, []);

  useEffect(() => {
    if (isDesktop) return;
    reclamp();
    const vv = window.visualViewport;
    window.addEventListener("resize", reclamp);
    window.addEventListener("orientationchange", reclamp);
    vv?.addEventListener("resize", reclamp);
    vv?.addEventListener("scroll", reclamp);
    return () => {
      window.removeEventListener("resize", reclamp);
      window.removeEventListener("orientationchange", reclamp);
      vv?.removeEventListener("resize", reclamp);
      vv?.removeEventListener("scroll", reclamp);
    };
  }, [isDesktop, reclamp]);

  useEffect(() => {
    if (isDesktop) return;
    reclamp();
  }, [callBarHeight, isDesktop, reclamp]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const a = active.current;
    if (!a || e.pointerId !== a.pointerId) return;
    moved.current = true;
    const cbh = callBarHeightRef.current;
    if (a.kind === "drag") {
      setPos(clampPos({ x: e.clientX - a.offsetX, y: e.clientY - a.offsetY }, widthRef.current, cbh));
    } else {
      // Width = distance from pointer to the anchored right edge; top-left is
      // recomputed and clamped into the box.
      const w = clampWidth(a.anchorRight - e.clientX, cbh);
      widthRef.current = w;
      setWidth(w);
      setPos(clampPos({ x: a.anchorRight - w, y: a.anchorBottom - panelHeight(w) }, w, cbh));
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
        if (cur) savePos(cur);
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
      const cur = posRef.current;
      if (!cur) return;
      active.current = {
        kind: "resize",
        pointerId: e.pointerId,
        anchorRight: cur.x + widthRef.current,
        anchorBottom: cur.y + panelHeight(widthRef.current),
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

  if (isDesktop) return null;

  const dragging = gesture !== null;

  return (
    <div
      ref={panelRef}
      onClickCapture={swallowClick}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden select-none touch-none",
        "clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        // See FloatingCallStage: `duration-200` would otherwise tween `left`/`top`.
        "transition-none",
        // Invisible until placed, so it never flashes at the origin.
        pos ? "opacity-100" : "opacity-0 pointer-events-none",
        !entered && "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
        "sidebar:hidden",
      )}
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        width,
      }}
    >
      <div
        className="flex items-center gap-0.5 px-1 shrink-0 border-b border-white/10"
        style={{ height: HEADER_H }}
      >
        <div
          onPointerDown={beginResize}
          role="presentation"
          aria-label="Resize call preview"
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
            "flex items-center justify-center gap-1 flex-1 min-w-0 h-full rounded-md px-1 touch-none",
            gesture === "drag" ? "cursor-grabbing" : "cursor-grab",
          )}
          role="presentation"
          aria-label="Drag call preview"
        >
          <GripHorizontal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-xs font-medium text-muted-foreground truncate">Call</span>
        </div>
        {onExpand && (
          <button
            type="button"
            aria-label="Return to call"
            title="Return to call"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onExpand}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10 touch:p-1.5"
          >
            <Maximize2 className="size-4" />
          </button>
        )}
        <button
          type="button"
          aria-label="Hide video preview"
          title="Hide video preview"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onHide}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-foreground/10 touch:p-1.5"
        >
          <X className="size-4" />
        </button>
      </div>
      {/* Reparent target. Pointer events off mid-gesture so a moving finger can't tap a tile. */}
      <div ref={bodyRef} className={cn("w-full", dragging && "pointer-events-none")} />
    </div>
  );
}
