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

/** Settle animation, vaul's curve so the two kinds of sheet move alike. */
const SETTLE_MS = 320;
const DISMISS_MS = 240;

/** Travel before a touch is committed to a direction. */
const SLOP_PX = 6;

/** Scrim opacity at peek and at full. */
const SCRIM_PEEK = 0.45;
const SCRIM_FULL = 0.8;

/** Marks the one scrollable region whose scroll the sheet's drag hands off to. */
export const SHEET_SCROLL_ATTR = "data-sheet-scroll";

/** Marks a region (a full-screen preview) that a drag on must not move the sheet. */
export const SHEET_NO_DRAG_ATTR = "data-sheet-no-drag";

function ease(t: number): number {
  // cubic-bezier(0.32, 0.72, 0, 1) is close enough to an ease-out quint here.
  return 1 - Math.pow(1 - t, 5);
}

interface SnapSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the sheet rests at full height rather than at peek. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Accessible name. */
  title: string;
  className?: string;
  children: ReactNode;
}

/**
 * A bottom sheet in the shape of Discord's media picker: it rests at a peek
 * height with the conversation visible above, and a pull on it — the handle,
 * or the grid itself — expands it to the full screen. The drag and the list
 * inside are one gesture: swiping up the grid first raises the sheet and then
 * scrolls, and pulling down a scrolled-to-top grid collapses it, to peek and
 * then away.
 *
 * Built on Radix Dialog rather than vaul, which only drags while its content
 * is scrolled to the top and never hands a drag on to the list.
 *
 * Every frame of a drag is a direct style write — no React state — so the
 * sheet tracks the finger without re-rendering the grid. Children read the
 * sheet's position from two CSS variables on the content element:
 * `--sheet-x` (0 at peek … 1 at full) and `--sheet-offset` (px the sheet sits
 * below full), which is what lets a footer stay pinned to the screen bottom.
 */
export function SnapSheet({ open, onOpenChange, expanded, onExpandedChange, title, className, children }: SnapSheetProps) {
  // Mounted from open until the close animation has finished.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);

  // The content node as STATE: Radix's Portal renders nothing on its first
  // commit, so a plain ref is still null when effects first run and they
  // would never run again — leaving the sheet with no drag at all.
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

  // Open: start below the screen and rise to the requested stop.
  useLayoutEffect(() => {
    if (!node || !open) return;
    openedAt.current = Date.now();
    measure();
    paint(stops.current.closed);
    animateTo(stopOffset(expandedRef.current ? "full" : "peek", stops.current), SETTLE_MS);
    return () => cancelAnimationFrame(frame.current);
  }, [node, open, measure, paint, animateTo]);

  // Close: sink from wherever the sheet is, then unmount.
  useEffect(() => {
    if (open || !present) return;
    animateTo(stops.current.closed, DISMISS_MS, () => setPresent(false));
  }, [open, present, animateTo]);

  // The parent asked for the other rest height.
  useEffect(() => {
    if (!open || !node) return;
    animateTo(stopOffset(expanded ? "full" : "peek", stops.current), SETTLE_MS);
  }, [expanded, open, node, animateTo]);

  // Rotation, a window resize: the stops move with the screen.
  useEffect(() => {
    if (!present) return;
    const onResize = () => {
      if (!open) return;
      measure();
      // An animation still in flight is heading for a stop measured against
      // the old height; land on the new one instead of letting it finish there.
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
    // The expanded effect only runs on a change; a release that lands back
    // where it started has to be animated here.
    animateTo(stopOffset(stop, stops.current), SETTLE_MS);
    if (full !== expandedRef.current) onExpandedChangeRef.current(full);
  }, [animateTo]);

  // The drag. Touch events rather than pointer events: only a non-passive
  // touchmove can refuse the browser its own scroll, and whether to refuse is
  // decided per move — the sheet and the grid take turns within one gesture.
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
      // A settle in flight keeps running until the drag actually takes the
      // sheet: a tap, a sideways swipe or a grid scroll must not freeze it
      // wherever the touch happened to land.
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

      // Whether the sheet may take this move, given where it rests and where
      // the grid is scrolled.
      const atFull = offset.current <= 0.5;
      const sheetMayTake = !scroller || !atFull || (dy > 0 && scroller.scrollTop <= 0);

      if (mode === "pending") {
        const tx = touch.clientX - startX;
        const ty = touch.clientY - startY;
        if (Math.abs(tx) < SLOP_PX && Math.abs(ty) < SLOP_PX) {
          // Inside the slop a move the sheet may own is still refused to the
          // browser: once it starts a scroll, touchmove stops being cancelable.
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
        // Only while the browser has not begun a scroll of its own — the grid
        // was already at its top, so the pull scrolled nothing. Once Chrome
        // starts scrolling, touchmove stays uncancelable for the rest of the
        // gesture, so a grid flung back up to its top mid-gesture does NOT
        // hand over here: that finger keeps scrolling, and the next pull down
        // moves the sheet.
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
      // Velocity over the last ~100ms of the drag; an older sample would let
      // a pause before release still read as a fling.
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
          // Opacity is painted per frame; pointer-events drop the moment a
          // close starts, for the reason given in ui/drawer.tsx.
          className={cn("fixed inset-0 z-50 bg-black", !open && "!pointer-events-none")}
          style={{ opacity: 0 }}
        />
        <DialogPrimitive.Content
          ref={setContent}
          aria-describedby={undefined}
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            // Take focus off the composer so the keyboard goes down, without
            // landing a focus ring on the first control in the sheet.
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
            // Full height from the status bar down; the rest heights are
            // translations of it, so a drag never re-lays-out the grid.
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
