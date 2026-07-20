import { GripHorizontal, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useIsDesktop } from "@/hooks/useIsDesktop";
import { cn } from "@/lib/utils";

/** Gap kept from the viewport edges for the default position and clamping. */
const EDGE_MARGIN = 12;
/** localStorage keys for the persisted top-left position and width. */
const POSITION_KEY = "armada:floating-call:pos";
const SIZE_KEY = "armada:floating-call:width";

/**
 * Width limits (px). Width is the single resizable dimension: the media area is
 * a 16:9 box of the width, and the fixed-height header and media-control row sit
 * above/below it, so the whole panel scales from one number.
 *
 *  - `MIN_WIDTH` (~280) keeps the header (grips + return/hide) and the
 *    media-control row (mic/cam/share/leave) usable and the video legible.
 *  - `DEFAULT_WIDTH` (320) matches the previous fixed panel width.
 *  - `MAX_WIDTH_CAP` (640) is an absolute ceiling so the panel never grows to
 *    cover nearly the whole viewport on a large monitor.
 *
 * The effective maximum is the smaller of `MAX_WIDTH_CAP` and the largest width
 * whose full panel (header + 16:9 body + controls) still fits the current
 * viewport in BOTH axes — see `clampWidth`.
 */
const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 320;
const MAX_WIDTH_CAP = 640;

/** The 16:9 media aspect ratio; media-area height = width * 9/16. */
const BODY_RATIO = 9 / 16;
/**
 * Fixed chrome heights (px) used only to estimate the panel height when
 * clamping WIDTH against the viewport height (so a short viewport can't produce
 * a panel taller than the screen). Position clamping uses the panel's REAL
 * measured height, so these are deliberately conservative estimates: header row
 * (~34px) + media-control row (~44px). They don't need to be pixel-exact — the
 * measured re-clamp corrects any drift.
 */
const HEADER_H = 34;
const CONTROLS_H = 44;
const CHROME_H = HEADER_H + CONTROLS_H;

interface Point {
  x: number;
  y: number;
}

/** Estimated total panel height for a width (header + 16:9 body + controls). */
function estPanelHeight(width: number): number {
  return CHROME_H + width * BODY_RATIO;
}

/** Read the persisted position, or null if none/invalid. */
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

/**
 * Clamp a width to [MIN_WIDTH, max], where max is the largest width whose full
 * panel (header + 16:9 body + controls) still fits the current viewport, capped
 * at MAX_WIDTH_CAP. Bounded by BOTH the viewport width and its height (via the
 * body ratio + chrome estimate) so a short viewport can't produce a panel taller
 * than the screen.
 */
function clampWidth(width: number): number {
  const availW = window.innerWidth - EDGE_MARGIN * 2;
  const availH = window.innerHeight - EDGE_MARGIN * 2;
  const maxByHeight = (availH - CHROME_H) / BODY_RATIO;
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH_CAP, availW, maxByHeight));
  return Math.min(Math.max(width, MIN_WIDTH), max);
}

/**
 * Clamp a top-left point so the whole `width`×`height` panel stays on screen.
 * `height` is the panel's REAL measured height when available (falling back to
 * the width-derived estimate before the stage is reparented in).
 */
function clampToViewport(p: Point, width: number, height: number): Point {
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
  return {
    x: Math.min(Math.max(p.x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(p.y, EDGE_MARGIN), maxY),
  };
}

/** Default bottom-right position for a panel of the given size. */
function defaultPosition(width: number, height: number): Point {
  return {
    x: Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN),
    y: Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN),
  };
}

/**
 * The compact, draggable AND resizable floating call window shown while a call
 * is active but its channel is off screen. It is pure chrome: a fixed desktop
 * panel whose body is registered as the floating stage host, into which
 * CallProvider reparents the persistent stage host (where the one-and-only
 * `CallStage` lives). Because it's the SAME stage element being moved — not a
 * second stage — there is never a duplicate LiveKit subscription, and video
 * keeps playing across the reparent (CallProvider re-kicks any paused `<video>`
 * on move).
 *
 * The panel is freely positioned by DRAG of the centered title area in its
 * header, and RESIZED by dragging the visible TOP-LEFT handle — which anchors
 * the bottom-right corner, so dragging up/left enlarges and down/right shrinks.
 * Width is the single resizable dimension: the media preview is a 16:9 box of
 * the width and the fixed-height header + media-control row sit above/below it,
 * so the whole panel scales from one number while the 16:9 media area is always
 * preserved. Both gestures use pointer events; neither starts from an action
 * button, the video body, or the other handle, and a completed gesture
 * suppresses the trailing click so a fast gesture can't land on a tile/control.
 * Position and width persist to localStorage independently.
 *
 * Position and size are always clamped to the visible viewport (minus an edge
 * margin), re-clamping on window resize and content-driven size changes. Width
 * clamping uses a conservative chrome estimate; position clamping uses the
 * panel's REAL measured height, so the complete panel is always visible.
 *
 * The dragged/resized frame lives here (position/size/persistence/clamping); the
 * compact single-content preview and the media controls (mic/camera/share/leave)
 * live in `CallStage`'s floating branch — inside the LiveKit context — so they
 * reuse the room's existing state rather than duplicating any media handles.
 *
 * Desktop only: below the `sidebar` breakpoint we render nothing and register
 * no host, so the compact `MobileCallPreview` (which registers only below that
 * breakpoint) is the sole floating destination there. The two never register at
 * once. Native browser Picture-in-Picture is out of scope.
 */
export function FloatingCallStage({
  registerSlot,
  onExpand,
  onHide,
}: {
  /** Register (or clear, with null) the body element as the floating stage host. */
  registerSlot: (el: HTMLElement | null, variant?: "desktop" | "mobile") => void;
  /** Return to the full call view (navigate to the call's channel). */
  onExpand?: () => void;
  /** Hide the floating window without leaving the call. */
  onHide: () => void;
}) {
  const isDesktop = useIsDesktop();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Persisted width; clamped against the live viewport on mount and on change.
  const [width, setWidth] = useState<number>(() => loadWidth());
  // Null until the first layout pass positions the panel (we need its measured
  // height to clamp/default). Rendered invisibly for that one frame.
  const [pos, setPos] = useState<Point | null>(null);
  const [gesture, setGesture] = useState<null | "drag" | "resize">(null);

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
  // Latest width/position in refs for handlers that must not re-close.
  const widthRef = useRef(width);
  widthRef.current = width;
  const posRef = useRef<Point | null>(pos);
  posRef.current = pos;

  // Register the body as the reparent target only on desktop and only while
  // mounted; clearing on unmount/mobile parks the stage off-DOM instead of
  // stranding it inside a hidden panel (a display:none ancestor pauses video).
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

  // Initial placement: clamp the persisted width, then restore the persisted
  // position (clamped to the current viewport, in case it shrank) or fall back
  // to bottom-right. Runs after the panel mounts. The panel's final height isn't
  // known yet here — the stage host (video + controls) is reparented in
  // asynchronously — so this uses the width-derived estimate; the ResizeObserver
  // below corrects it once the real height settles. `pos` stays null (panel held
  // invisible) until this runs, so there's no top-left flash.
  useLayoutEffect(() => {
    if (!isDesktop) return;
    const el = panelRef.current;
    if (!el) return;
    const w = clampWidth(loadWidth());
    setWidth(w);
    const height = el.offsetHeight || estPanelHeight(w);
    const saved = loadPosition();
    setPos(clampToViewport(saved ?? defaultPosition(w, height), w, height));
  }, [isDesktop]);

  // Re-clamp against the panel's ACTUAL rendered size whenever it changes. The
  // panel is short on first paint (just the header) and grows when CallProvider
  // reparents the stage + controls into it; without this the initial clamp uses
  // the too-small height and the panel opens too low. The observer re-clamps the
  // current top-left using the final height, so the complete panel is always
  // visible — and it also covers later content-driven size changes. A saved
  // position is re-clamped the same way, never trusted blindly.
  useEffect(() => {
    if (!isDesktop) return;
    const el = panelRef.current;
    if (!el) return;
    const reclamp = () => {
      // Don't fight an in-progress gesture; those handlers already clamp.
      if (active.current) return;
      const height = el.offsetHeight || estPanelHeight(widthRef.current);
      setPos((cur) => (cur ? clampToViewport(cur, widthRef.current, height) : cur));
    };
    const ro = new ResizeObserver(reclamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop]);

  // Re-clamp whenever the viewport resizes so the panel never drifts off screen
  // (width first — the viewport may have shrunk below the panel — then position
  // against the new width and the real measured height).
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
      // Resize from the TOP-LEFT handle with the bottom-right corner anchored:
      // width is the distance from the pointer's x to the fixed right edge, so
      // dragging left/up enlarges and right/down shrinks. Height follows via the
      // 16:9 media box + fixed chrome. The top-left is recomputed from the anchor
      // and the new size, then clamped so the whole panel stays on screen. Growth
      // pushes the top-left toward the top/left edges — exactly where the clamp
      // guards — so the bottom-right stays put until a clamp is hit, then the
      // whole panel is held on screen. Position clamping uses the panel's REAL
      // measured height so it tracks the actual chrome, not just the estimate.
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
      // Persist resting geometry (position and width independently).
      setPos((cur) => {
        if (cur) savePosition(cur);
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
      // Only start a drag from the primary mouse button.
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
      // Anchor the bottom-right corner: capture it once at gesture start (from
      // the panel's REAL rect) so the whole resize grows/shrinks toward this
      // fixed point (top-left handle).
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

  // Mobile: no floating window (the fixed call bar remains the voice UI).
  if (!isDesktop) return null;

  const busy = gesture !== null;

  return (
    <div
      ref={panelRef}
      onClickCapture={swallowClick}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden select-none",
        "clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        // Hold invisible for the single frame before the first layout pass
        // positions it, so it never flashes at the top-left origin.
        pos ? "opacity-100" : "opacity-0 pointer-events-none",
        !busy && "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
      )}
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        width,
      }}
    >
      <div className="flex items-center gap-0.5 px-1 py-1 shrink-0 border-b border-white/10">
        {/* Top-left resize handle: its own pointer gesture; it never starts a
            drag (the drag lives on the centered title area, its sibling). The
            bottom-right corner stays anchored while resizing. `touch-none` keeps
            touch/pen gestures from scrolling instead of resizing. */}
        <div
          onPointerDown={beginResize}
          role="presentation"
          aria-label="Resize floating call window"
          className={cn(
            "shrink-0 flex items-center justify-center touch-none cursor-nwse-resize",
            // Larger invisible pointer target; the grip is NOT a button, so no
            // surface/background/border — only a subtle color+opacity that
            // sharpens on hover or while resizing.
            "size-6 touch:size-8",
            "text-muted-foreground opacity-50 hover:opacity-100 hover:text-foreground transition-opacity",
            gesture === "resize" && "opacity-100 text-foreground",
          )}
        >
          {/* Textarea-style corner resize grip: short parallel diagonal strokes
              clustered at the top-left corner (mirrored from the usual
              bottom-right textarea marks). Inherits currentColor. */}
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
        {/* Draggable centered title area: dragging is scoped to THIS region
            only, so the resize handle and the action buttons never start a drag,
            and the interactive video body is never draggable. A centered
            horizontal grip is the primary drag affordance; the "Call" label sits
            beside it when there's room. `touch-none` keeps touch/pen gestures
            from scrolling instead of dragging. */}
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
        {onExpand && (
          <button
            type="button"
            aria-label="Return to call"
            title="Return to call"
            // Stop the drag area (its sibling) from ever seeing this gesture.
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
      {/* The reparent target: CallProvider appends the stage host here. The
          host's CallStage floating branch renders the compact preview + the
          media controls. While a gesture is active, disable pointer events on
          the content so a fast drag/resize can't land a stray click on a
          tile/control. */}
      <div ref={bodyRef} className={cn("w-full", busy && "pointer-events-none")} />
    </div>
  );
}
