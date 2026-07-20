import { GripHorizontal, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useCall } from "@/hooks/useCall";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { cn } from "@/lib/utils";

/** localStorage keys for the persisted preview geometry. */
const POS_KEY = "armada:mobile-call-preview:pos";
const SIZE_KEY = "armada:mobile-call-preview:width";

/** Gap kept from every viewport edge (and from the call bar). */
const EDGE_GAP = 8;
/** Fixed header height (px) — used to compute total panel height from width. */
const HEADER_H = 32;
/** The 16:9 media aspect ratio; body height = width * 9/16. */
const BODY_RATIO = 9 / 16;

/**
 * Width limits. The minimum keeps the header (return / hide / grip / resize)
 * usable and the video legible; the maximum is derived per-clamp from the
 * current visible viewport (never the full width, and always leaving room for
 * the call bar) — see `clampWidth`. `MAX_WIDTH_CAP` is an absolute ceiling so
 * the panel never grows absurdly on a wide landscape viewport.
 */
const MIN_WIDTH = 128;
const MAX_WIDTH_CAP = 460;

interface Point {
  x: number;
  y: number;
}

/**
 * The visible viewport rect the preview must stay within, and the safe-area
 * insets to keep clear. Uses `visualViewport` when available so the box shrinks
 * with the on-screen keyboard (and tracks pinch/scroll offsets); falls back to
 * the layout viewport otherwise. `callBarHeight` (which already folds in the
 * bottom safe-area inset) is reserved at the bottom so the panel can never
 * overlap the fixed MobileCallBar.
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

  // Safe-area insets (landscape notches, status bar, home indicator). Read from
  // the root computed style; the call bar already accounts for the BOTTOM inset,
  // so only top/left/right are added here.
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

/** Total panel height (header + 16:9 body) for a given width. */
function panelHeight(width: number): number {
  return HEADER_H + width * BODY_RATIO;
}

/**
 * Clamp a width to [MIN_WIDTH, max], where max is the largest width whose full
 * panel (header + 16:9 body) still fits the current visible viewport box, capped
 * at MAX_WIDTH_CAP. Width is bounded by BOTH the box width and the box height
 * (via the body ratio) so a short landscape viewport can't produce a panel
 * taller than the screen.
 */
function clampWidth(width: number, callBarHeight: number): number {
  const box = viewportBox(callBarHeight);
  const maxByWidth = box.width;
  const maxByHeight = (box.height - HEADER_H) / BODY_RATIO;
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH_CAP, maxByWidth, maxByHeight));
  return Math.min(Math.max(width, MIN_WIDTH), max);
}

/**
 * Clamp a top-left point so the whole `width`×(header+body) panel stays inside
 * the current visible viewport box (which reserves the call bar + safe areas).
 */
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

/** Default bottom-right position for a panel of the given width. */
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
 * The compact mobile video preview shown while a call is active but its channel
 * is off screen. It is the mobile counterpart to the draggable desktop
 * `FloatingCallStage`: pure chrome whose body is registered as the floating
 * stage host, into which CallProvider reparents the persistent stage host
 * (where the one-and-only `CallStage` lives). Because it's the SAME stage
 * element being moved — not a second stage — there is never a duplicate LiveKit
 * subscription, and video keeps playing across the reparent (CallProvider
 * re-kicks any paused `<video>` on move).
 *
 * The preview is freely positioned by one-finger DRAG of the title area in its
 * header, and RESIZED (keeping the 16:9 media ratio) by dragging the visible
 * TOP-LEFT handle in the header — which anchors the bottom-right corner, so
 * dragging up/left enlarges and down/right shrinks. Both gestures use pointer
 * events, so touch, pen, and mouse all work. Neither gesture starts from an
 * action button, the video tile, or the other handle, and a completed gesture
 * suppresses the trailing click so it can't land on the preview content.
 * Position and width persist to localStorage.
 *
 * Position and size are always clamped to the VISIBLE viewport
 * (`window.visualViewport` when available, so it shrinks with the on-screen
 * keyboard), minus the safe-area insets and the fixed MobileCallBar's height
 * (`callBarHeight` from the call context, which already folds in the bottom
 * safe area). The panel therefore never overlaps the call bar or crosses the
 * gutters, and it re-clamps on rotation, viewport resize, keyboard show/hide,
 * safe-area changes, and call-bar height changes.
 *
 * The header carries only the actions that must live here: "return to call"
 * (expand) and "hide". Mic / camera / screen-share / leave stay in the
 * always-present MobileCallBar; the stage's floating branch renders the primary
 * content (and, for multiple screen shares, the switcher) — see CallStage.
 *
 * Mobile only: at/above the `sidebar` breakpoint we render nothing and register
 * no host, so the desktop `FloatingCallStage` (which registers only at that
 * breakpoint) is the sole floating destination there. The two never register at
 * once. Native browser Picture-in-Picture (and pinch resizing) are out of scope.
 */
export function MobileCallPreview({
  registerSlot,
  onExpand,
  onHide,
}: {
  /** Register (or clear, with null) the body element as the floating stage host. */
  registerSlot: (el: HTMLElement | null, variant?: "desktop" | "mobile") => void;
  /** Return to the full call view (navigate to the call's channel). */
  onExpand?: () => void;
  /** Hide the preview without leaving the call. */
  onHide: () => void;
}) {
  const isDesktop = useIsDesktop();
  const { callBarHeight } = useCall();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Persisted width; clamped against the live viewport on mount and on every
  // change. Position is null until the first layout pass places it (held
  // invisible for that frame so it never flashes at the origin).
  const [width, setWidth] = useState<number>(() => loadWidth());
  const [pos, setPos] = useState<Point | null>(null);
  const [gesture, setGesture] = useState<null | "drag" | "resize">(null);
  // Latches true once the panel has completed its one-time entry animation. The
  // entry animation is gated on !entered (NOT on gesture state) so it plays only
  // when the panel first appears; dragging/resizing never re-adds the animate-in
  // classes, so a gesture end can't replay the fade/slide (which looked like a
  // blink). Reset on unmount/hide via fresh mount, so reopening animates again.
  const [entered, setEntered] = useState(false);

  // Live gesture bookkeeping in a ref so the move handler doesn't re-close.
  const active = useRef<
    | { kind: "drag"; pointerId: number; offsetX: number; offsetY: number }
    // Resize is anchored at the panel's bottom-right corner (captured at gesture
    // start), so dragging the top-left handle grows/shrinks toward that fixed point.
    | { kind: "resize"; pointerId: number; anchorRight: number; anchorBottom: number }
    | null
  >(null);
  // Set true once a gesture actually moved, so the trailing click is swallowed.
  const moved = useRef(false);
  // Latest width/position in refs for handlers that must not re-close on state
  // changes (and so the resize handler can read the fixed top-left directly).
  const widthRef = useRef(width);
  widthRef.current = width;
  const posRef = useRef<Point | null>(pos);
  posRef.current = pos;
  const callBarHeightRef = useRef(callBarHeight);
  callBarHeightRef.current = callBarHeight;

  // Register the body as the reparent target only on mobile and only while
  // mounted; clearing on unmount/desktop parks the stage off-DOM instead of
  // stranding it inside a hidden panel (a display:none ancestor pauses video).
  // Registers under the "mobile" variant so the stage's floating branch knows
  // to omit the media control row (MobileCallBar already carries it).
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

  // Initial placement: clamp the persisted width, then restore the persisted
  // position (clamped to the current viewport) or fall back to bottom-right.
  useLayoutEffect(() => {
    if (isDesktop) return;
    const w = clampWidth(loadWidth(), callBarHeightRef.current);
    setWidth(w);
    const saved = loadPos();
    setPos(clampPos(saved ?? defaultPos(w, callBarHeightRef.current), w, callBarHeightRef.current));
  }, [isDesktop]);

  // Latch `entered` once the panel first becomes visible (pos set). The
  // animate-in classes render on that first visible frame; this flips them off
  // afterward (via a timeout longer than the 200ms animation) so they're never
  // re-applied on gesture end. Runs once because it early-returns after latching.
  useEffect(() => {
    if (!pos || entered) return;
    const t = setTimeout(() => setEntered(true), 250);
    return () => clearTimeout(t);
  }, [pos, entered]);

  // Re-clamp on any viewport change: rotation, resize, keyboard show/hide
  // (visualViewport resize/scroll), and safe-area changes. Also re-runs when
  // callBarHeight changes (below). Never fights an in-progress gesture (those
  // handlers clamp live).
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

  // Re-clamp when the call bar's height changes (roster count, keyboard-driven
  // bar reflow) so the panel keeps clear of it.
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
      // Resize from the TOP-LEFT handle with the bottom-right corner anchored:
      // width is the distance from the pointer's x to the fixed right edge, so
      // dragging left/up enlarges and right/down shrinks. Height follows via the
      // 16:9 body ratio (the body is aspect-video). The top-left position is
      // recomputed from the anchor and the new size, then clamped so the whole
      // panel stays inside the viewport box (which reserves the call bar + safe
      // areas). Growth pushes the top-left toward the top/left edges — exactly
      // where the clamp guards — so the bottom-right stays put until a clamp is
      // hit, then the whole panel is held on screen.
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
      // Persist resting geometry.
      setPos((cur) => {
        if (cur) savePos(cur);
        return cur;
      });
      saveWidth(widthRef.current);
      // Clear the moved flag on the next tick so the click that fires right
      // after pointerup (if any) is still suppressed, but later clicks aren't.
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
      // Anchor the bottom-right corner: capture it once at gesture start so the
      // whole resize grows/shrinks toward this fixed point (top-left handle).
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

  // Swallow the synthetic click that follows a moving gesture, so a drag/resize
  // that ends over a button or the video tile can't trigger it.
  const swallowClick = useCallback((e: React.MouseEvent) => {
    if (moved.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  // Clean up global listeners if we unmount mid-gesture.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endGesture);
      window.removeEventListener("pointercancel", endGesture);
    },
    [onPointerMove, endGesture],
  );

  // Desktop: no mobile preview (the draggable FloatingCallStage is the floating
  // destination there).
  if (isDesktop) return null;

  const dragging = gesture !== null;

  return (
    <div
      ref={panelRef}
      onClickCapture={swallowClick}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden select-none touch-none",
        "clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        // Hold invisible for the single frame before the first layout pass
        // positions it, so it never flashes at the top-left origin.
        pos ? "opacity-100" : "opacity-0 pointer-events-none",
        // Play the entry fade/slide only on first appearance — never re-added on
        // gesture end (which caused a blink). Gated on !entered, not gesture.
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
        {/* Top-left resize handle (in the grip's former spot). Its own pointer
            gesture; it never starts a drag (the drag lives on the title area,
            its sibling). Bottom-right corner stays anchored while resizing. */}
        <div
          onPointerDown={beginResize}
          role="presentation"
          aria-label="Resize call preview"
          className={cn(
            "shrink-0 flex items-center justify-center touch-none cursor-nwse-resize",
            // Larger invisible touch target; the grip is not a button, so no
            // surface/background — only a subtle color+opacity that sharpens on
            // hover or while resizing.
            "size-6 touch:size-8",
            "text-muted-foreground opacity-50 hover:opacity-100 hover:text-foreground transition-opacity",
            gesture === "resize" && "opacity-100 text-foreground",
          )}
        >
          {/* Textarea-style corner resize grip: 3 short parallel diagonal
              strokes clustered at the top-left corner (mirrored from the usual
              bottom-right textarea marks). ~13px, inherits currentColor. */}
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
        {/* Draggable title/empty area: dragging is scoped to THIS region only,
            so the resize handle and the action buttons never start a drag, and
            the interactive video body (which may gain controls later) is never
            draggable. A centered horizontal grip is the primary drag affordance;
            the "Call" label sits beside it when there's room. */}
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
            // Stop the drag area (its sibling) from ever seeing this gesture.
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
      {/* The reparent target: CallProvider appends the stage host here. The
          host's CallStage floating branch renders the compact preview (and, for
          multiple screen shares, the share switcher) — but NOT the media
          controls, which stay in MobileCallBar. While a gesture is active,
          disable pointer events on the content so a moving finger can't land a
          stray tap on a tile/selector. */}
      <div ref={bodyRef} className={cn("w-full", dragging && "pointer-events-none")} />
    </div>
  );
}
