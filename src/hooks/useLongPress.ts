import { useCallback, useEffect, useRef } from "react";

/** How long a finger must rest before the press counts as a long press. */
export const LONG_PRESS_MS = 500;

/** How far it may drift first — beyond this the gesture is a scroll or swipe. */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * Interactive descendants that own their own press behaviour, so a press
 * starting on one must not also open the row's menu.
 */
const INTERACTIVE = "button, a, input, textarea, select, [role='button'], [role='menuitem']";

/**
 * Press-and-hold detection for touch devices, returning props to spread on the
 * element.
 *
 * Touch only, by design: on a pointer device the equivalent affordance is the
 * hover toolbar and right-click menu, and arming this for the mouse would make
 * a slow click open a menu.
 */
export function useLongPress(onLongPress: (() => void) | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  // Set once the press fires, so the click and context menu that follow the
  // release don't act on top of the menu we just opened.
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (!onLongPress || e.pointerType !== "touch") return;
      if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        timer.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!timer.current || !origin.current) return;
      const { x, y } = origin.current;
      if (Math.hypot(e.clientX - x, e.clientY - y) > LONG_PRESS_SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClick: (e: React.MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu: (e: React.MouseEvent) => {
      // Suppress the platform's own long-press callout on top of our sheet.
      if (fired.current) e.preventDefault();
    },
  };
}
