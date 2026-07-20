import { GripVertical, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useIsDesktop } from "@/hooks/useIsDesktop";
import { cn } from "@/lib/utils";

/** Panel width (px). Kept in JS so drag-clamping can reason about bounds. */
const PANEL_WIDTH = 320;
/** Gap kept from the viewport edges for the default position and clamping. */
const EDGE_MARGIN = 12;
/** localStorage key for the persisted top-left position. */
const POSITION_KEY = "armada:floating-call:pos";

interface Point {
  x: number;
  y: number;
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

/** Clamp a top-left point so the whole `width`×`height` panel stays on screen. */
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
 * The compact, draggable floating call window shown while a call is active but
 * its channel is off screen. It is pure chrome: a fixed desktop panel whose
 * body is registered as the floating stage host, into which CallProvider
 * reparents the persistent stage host (where the one-and-only `CallStage`
 * lives). Because it's the SAME stage element being moved — not a second stage
 * — there is never a duplicate LiveKit subscription, and video keeps playing
 * across the reparent (CallProvider re-kicks any paused `<video>` on move).
 *
 * The dragged frame lives here (position/persistence/clamping); the compact
 * single-content preview and the media controls (mic/camera/leave) live in
 * `CallStage`'s floating branch — inside the LiveKit context — so they reuse
 * the room's existing state rather than duplicating any media handles.
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

  // Null until the first layout pass positions the panel (we need its measured
  // height to clamp/default). Rendered invisibly for that one frame.
  const [pos, setPos] = useState<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  // Live drag bookkeeping in a ref so the move handler doesn't re-close.
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

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

  // Initial placement: restore the persisted position (clamped to the current
  // viewport, in case it shrank) or fall back to bottom-right. Runs after the
  // panel mounts. The panel's final height isn't known yet here — the stage
  // host (video + controls) is reparented in asynchronously — so this is a
  // provisional placement that the ResizeObserver below corrects once the real
  // height settles. `pos` stays null (panel held invisible) until this runs, so
  // there's no top-left flash.
  useLayoutEffect(() => {
    if (!isDesktop) return;
    const el = panelRef.current;
    if (!el) return;
    const height = el.offsetHeight || 240;
    const saved = loadPosition();
    setPos(clampToViewport(saved ?? defaultPosition(PANEL_WIDTH, height), PANEL_WIDTH, height));
  }, [isDesktop]);

  // Re-clamp against the panel's ACTUAL rendered size whenever it changes. The
  // panel is short on first paint (just the header) and grows when CallProvider
  // reparents the stage + controls into it; without this the initial clamp uses
  // the too-small height and the panel opens too low (its grown bottom edge
  // ends up near/under the viewport). The observer re-clamps the current
  // top-left using the final height, so the complete panel is always visible —
  // and it also covers later content-driven size changes. A saved position is
  // re-clamped the same way (using current dimensions), never trusted blindly.
  useEffect(() => {
    if (!isDesktop) return;
    const el = panelRef.current;
    if (!el) return;
    const reclamp = () => {
      // Don't fight an in-progress drag; the move handler already clamps.
      if (drag.current) return;
      const height = el.offsetHeight || 240;
      const width = el.offsetWidth || PANEL_WIDTH;
      setPos((cur) => (cur ? clampToViewport(cur, width, height) : cur));
    };
    const ro = new ResizeObserver(reclamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop]);

  // Re-clamp whenever the viewport resizes so the panel never drifts off screen.
  useEffect(() => {
    if (!isDesktop) return;
    const onResize = () => {
      const el = panelRef.current;
      const height = el?.offsetHeight || 240;
      setPos((cur) => (cur ? clampToViewport(cur, PANEL_WIDTH, height) : cur));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isDesktop]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const el = panelRef.current;
    const height = el?.offsetHeight || 240;
    setPos(clampToViewport({ x: e.clientX - d.offsetX, y: e.clientY - d.offsetY }, PANEL_WIDTH, height));
  }, []);

  const endDrag = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      setDragging(false);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      // Persist the resting position.
      setPos((cur) => {
        if (cur) savePosition(cur);
        return cur;
      });
    },
    [onPointerMove],
  );

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only start a drag from the primary button on the drag handle itself.
      if (e.button !== 0) return;
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      drag.current = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
      };
      setDragging(true);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
      e.preventDefault();
    },
    [onPointerMove, endDrag],
  );

  // Clean up global listeners if we unmount mid-drag.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    },
    [onPointerMove, endDrag],
  );

  // Mobile: no floating window (the fixed call bar remains the voice UI).
  if (!isDesktop) return null;

  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden select-none",
        "clip-corner-lg bg-chrome-deep shadow-2xl ring-1 ring-white/10",
        // Hold invisible for the single frame before the first layout pass
        // positions it, so it never flashes at the top-left origin.
        pos ? "opacity-100" : "opacity-0 pointer-events-none",
        !dragging && "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
      )}
      style={{
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        width: PANEL_WIDTH,
        maxWidth: "calc(100vw - 1.5rem)",
      }}
    >
      <div className="flex items-center gap-1 px-1 py-1 shrink-0 border-b border-white/10">
        {/* Drag handle: dragging is scoped to this grip + the label area so the
            action buttons never start a drag. `touch-none` keeps touch/pen
            gestures from scrolling instead of dragging. */}
        <div
          onPointerDown={onHandlePointerDown}
          className={cn(
            "flex items-center gap-1 flex-1 min-w-0 rounded-md px-1 py-0.5 touch-none",
            dragging ? "cursor-grabbing" : "cursor-grab",
          )}
          role="presentation"
          aria-label="Drag floating call window"
        >
          <GripVertical className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground truncate">Call</span>
        </div>
        {onExpand && (
          <button
            type="button"
            aria-label="Return to call"
            title="Return to call"
            // Stop the drag handle (its sibling) from ever seeing this gesture.
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
          media controls. While dragging, disable pointer events on the content
          so a fast drag can't land a stray click on a tile/control. */}
      <div ref={bodyRef} className={cn("w-full", dragging && "pointer-events-none")} />
    </div>
  );
}
