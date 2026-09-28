import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  dragStep,
  expansion,
  peekHeight,
  presence,
  settleStop,
  stopOffset,
  type SnapStop,
  type SnapStops,
} from "@/lib/snapSheet";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

/** See MessageActionSheet: the opening tap's trailing event reads as an outside tap. */
const OPEN_GUARD_MS = 400;

/** vaul's settle duration, so both kinds of sheet move alike. */
const SETTLE_MS = 320;
const DISMISS_MS = 240;

/** Travel before a touch is committed to a direction. */
const SLOP_PX = 6;

const SCRIM_PEEK = 0.45;
const SCRIM_FULL = 0.8;

/** Marks the one scrollable region whose scroll the sheet's drag hands off to. */
export const SHEET_SCROLL_ATTR = "data-sheet-scroll";

/** Marks a region (a full-screen preview) that a drag on must not move the sheet. */
export const SHEET_NO_DRAG_ATTR = "data-sheet-no-drag";

function ease(t: number): number {
  // Approximates vaul's cubic-bezier(0.32, 0.72, 0, 1).
  return 1 - Math.pow(1 - t, 5);
}

interface SnapSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  title: string;
  className?: string;
  children: ReactNode;
}

/**
 * Discord-style media-picker sheet: rests at peek, expands to full, and the
 * drag hands off to the inner list in one gesture. Radix Dialog, not vaul
 * (vaul never hands a drag on to the list). Drags write styles directly; children
 * read `--sheet-x` (0 peek … 1 full) and `--sheet-offset` (px below full).
 */
export function SnapSheet({ open, onOpenChange, expanded, onExpandedChange, title, className, children }: SnapSheetProps) {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  // STATE, not a ref: the Portal renders nothing on first commit, so effects
  // would never see the node.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const setContent = useCallback((el: HTMLDivElement | null) => {
    contentRef.current = el;
    setNode(el);
  }, []);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const offset = useRef(0);
  const stops = useRef<SnapStops>({ peek: 0, closed: 0 });
  const frame = useRef(0);
  const openedAt = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const onExpandedChangeRef = useRef(onExpandedChange);
  onExpandedChangeRef.current = onExpandedChange;

  const paint = useCallback((next: number) => {
    offset.current = next;
    const el = contentRef.current;
    if (el) {
      el.style.transform = `translate3d(0, ${next}px, 0)`;
      el.style.setProperty("--sheet-offset", `${next}px`);
      el.style.setProperty("--sheet-x", String(expansion(next, stops.current)));
    }
    const scrim = overlayRef.current;
    if (scrim) {
      const x = expansion(next, stops.current);
      scrim.style.opacity = String(presence(next, stops.current) * (SCRIM_PEEK + (SCRIM_FULL - SCRIM_PEEK) * x));
    }
  }, []);

  const animateTo = useCallback((target: number, duration: number, done?: () => void) => {
    cancelAnimationFrame(frame.current);
    const from = offset.current;
    if (Math.abs(from - target) < 0.5) {
      paint(target);
      done?.();
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      paint(from + (target - from) * ease(t));
      if (t < 1) frame.current = requestAnimationFrame(step);
      else done?.();
    };
    frame.current = requestAnimationFrame(step);
  }, [paint]);

  const measure = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const height = el.offsetHeight;
    stops.current = { peek: Math.max(0, height - peekHeight(height)), closed: height };
  }, []);

  useLayoutEffect(() => {
    if (!node || !open) return;
    openedAt.current = Date.now();
    measure();
    paint(stops.current.closed);
    animateTo(stopOffset(expandedRef.current ? "full" : "peek", stops.current), SETTLE_MS);
    return () => cancelAnimationFrame(frame.current);
  }, [node, open, measure, paint, animateTo]);

  useEffect(() => {
    if (open || !present) return;
    animateTo(stops.current.closed, DISMISS_MS, () => setPresent(false));
  }, [open, present, animateTo]);

  useEffect(() => {
    if (!open || !node) return;
    animateTo(stopOffset(expanded ? "full" : "peek", stops.current), SETTLE_MS);
  }, [expanded, open, node, animateTo]);

  useEffect(() => {
    if (!present) return;
    const onResize = () => {
      if (!open) return;
      measure();
      // Retarget an in-flight animation to the new stop.
      cancelAnimationFrame(frame.current);
      paint(stopOffset(expandedRef.current ? "full" : "peek", stops.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [present, open, measure, paint]);

  const settle = useCallback((stop: SnapStop) => {
    if (stop === "closed") {
      onOpenChangeRef.current(false);
      return;
    }
    const full = stop === "full";
    // A release landing where it started must be animated here (no state change).
    animateTo(stopOffset(stop, stops.current), SETTLE_MS);
    if (full !== expandedRef.current) onExpandedChangeRef.current(full);
  }, [animateTo]);

  // Touch events: only a non-passive touchmove can refuse the browser its scroll,
  // decided per move as sheet and grid take turns.
  useEffect(() => {
    const el = node;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let mode: "pending" | "sheet" | "scroll" | "none" = "none";
    let scroller: HTMLElement | null = null;
    let samples: { t: number; y: number }[] = [];

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !open || (e.target as HTMLElement).closest(`[${SHEET_NO_DRAG_ATTR}]`)) {
        mode = "none";
        return;
      }
      // An in-flight settle continues until the drag actually takes the sheet.
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = lastY = touch.clientY;
      scroller = (e.target as HTMLElement).closest<HTMLElement>(`[${SHEET_SCROLL_ATTR}]`);
      samples = [{ t: e.timeStamp, y: touch.clientY }];
      mode = "pending";
    };

    const onMove = (e: TouchEvent) => {
      if (mode === "none" || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dy = touch.clientY - lastY;
      samples.push({ t: e.timeStamp, y: touch.clientY });
      if (samples.length > 6) samples.shift();

      const atFull = offset.current <= 0.5;
      const sheetMayTake = !scroller || !atFull || (dy > 0 && scroller.scrollTop <= 0);

      if (mode === "pending") {
        const tx = touch.clientX - startX;
        const ty = touch.clientY - startY;
        if (Math.abs(tx) < SLOP_PX && Math.abs(ty) < SLOP_PX) {
          // Refuse the browser inside the slop: once it starts scrolling, touchmove
          // stops being cancelable.
          if (sheetMayTake && e.cancelable) e.preventDefault();
          lastY = touch.clientY;
          return;
        }
        if (Math.abs(tx) > Math.abs(ty)) {
          mode = "none";
          return;
        }
        mode = sheetMayTake ? "sheet" : "scroll";
        if (mode === "sheet") cancelAnimationFrame(frame.current);
      } else if (mode === "scroll" && sheetMayTake && e.cancelable) {
        // Only if the browser hasn't begun its own scroll (it stays uncancelable for the
        // rest of the gesture once it does).
        mode = "sheet";
        cancelAnimationFrame(frame.current);
      }

      if (mode !== "sheet") {
        lastY = touch.clientY;
        return;
      }
      if (e.cancelable) e.preventDefault();
      const next = dragStep(offset.current, scroller?.scrollTop ?? 0, dy, stops.current.closed);
      if (scroller && next.scrollTop !== scroller.scrollTop) scroller.scrollTop = next.scrollTop;
      paint(next.offset);
      lastY = touch.clientY;
    };

    const onEnd = (e: TouchEvent) => {
      if (mode !== "sheet") {
        mode = "none";
        return;
      }
      mode = "none";
      // Last ~100ms only, so a pause before release isn't a fling.
      const now = e.timeStamp;
      const recent = samples.filter((s) => now - s.t < 100);
      let velocity = 0;
      if (recent.length >= 2) {
        const first = recent[0];
        const last = recent[recent.length - 1];
        const dt = last.t - first.t;
        if (dt > 0) velocity = (last.y - first.y) / dt;
      }
      settle(settleStop(offset.current, velocity, stops.current));
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [node, open, paint, settle]);

  const guardOutside = (e: Event) => {
    e.preventDefault();
    if (Date.now() - openedAt.current < OPEN_GUARD_MS) return;
    onOpenChangeRef.current(false);
  };

  return (
    <DialogPrimitive.Root open={present} onOpenChange={(next) => { if (!next) onOpenChange(false); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          ref={overlayRef}
          // pointer-events drop the moment a close starts (see ui/drawer.tsx).
          className={cn("fixed inset-0 z-50 bg-black", !open && "!pointer-events-none")}
          style={{ opacity: 0 }}
        />
        <DialogPrimitive.Content
          ref={setContent}
          aria-describedby={undefined}
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            // Drop the keyboard without a focus ring on the first control.
            e.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
          onPointerDownOutside={guardOutside}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            onOpenChange(false);
          }}
          className={cn(
            // Rest heights are translations, so a drag never re-lays-out the grid.
            "fixed inset-x-0 bottom-0 top-[var(--safe-area-inset-top,env(safe-area-inset-top,0px))] z-50 flex flex-col overflow-hidden rounded-t-2xl bg-background shadow-[0_-8px_30px_rgba(0,0,0,0.25)] outline-none touch-none will-change-transform",
            !open && "!pointer-events-none",
            className,
          )}
          style={{ transform: "translate3d(0, 100%, 0)" }}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
