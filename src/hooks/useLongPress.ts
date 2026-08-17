import { useCallback, useEffect, useRef } from "react";

/**
 * How long a finger must rest before the press counts as a long press.
 *
 * Deliberately UNDER the platform's own long-press threshold (Android's
 * `ViewConfiguration` default and iOS's are both ~500ms). At 500 we tied with
 * the OS and sometimes lost: the system would claim the gesture for its own
 * long press — the buzz the user feels, with no menu behind it — and cancel
 * our pointer stream. Firing first means the sheet is already open by the time
 * the platform gets there.
 */
export const LONG_PRESS_MS = 400;

/**
 * How far it may drift first — beyond this the gesture is a scroll or swipe.
 * Deliberately generous: a thumb resting on glass for half a second wanders,
 * and a budget spent too early is a menu that never opens.
 */
export const LONG_PRESS_SLOP_PX = 16;

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
 *
 * A hold is given every benefit of the doubt, because the failure the user sees
 * is not a wrong menu — it is a press that does nothing. Two things disqualify
 * one: the finger travelling past {@link LONG_PRESS_SLOP_PX}, and a
 * `pointercancel` arriving before the hold has served its time. The second is
 * how a scroll actually presents: the browser suppresses the pointermoves
 * inside its OWN slop (~8–10px, under ours) and fires `pointercancel` the
 * moment it claims the pan, so the travel check alone never sees a scroll
 * coming and the armed timer would open the menu mid-scroll. A cancel whose
 * hardware timestamps already span the threshold is different — that is the
 * platform confiscating a completed hold (selection, callout, the system
 * long-press at ~500ms), and it fires rather than being swallowed.
 *
 * While a hold is armed the rest of the stream is watched on the WINDOW, not
 * on the element. The element's own handlers are not the whole truth: an
 * ancestor can take pointer capture mid-gesture — which is exactly what
 * `useEdgeSwipe` does when it claims the pane-reveal swipe, 10px in, under
 * this hook's own slop — and from that moment every further move, up and
 * cancel is retargeted to the capturing element, so a message row sees NOTHING
 * more of the touch that is dragging the whole pane across the screen. The
 * armed timer then fired mid-swipe and opened the action sheet on a message
 * the user was only resting a thumb on. Retargeting still bubbles to the
 * window, so listening there sees the gesture out whoever owns it.
 *
 * `allowInteractive` lifts the "ignore presses that start on a button/link"
 * guard, for the case where the interactive element IS the intended long-press
 * target (a message image, whose tap opens the lightbox but whose long-press
 * should open the message menu). The default keeps the guard, so a press on a
 * nested control never doubles as the container's long-press.
 */
export function useLongPress(
  onLongPress: (() => void) | undefined,
  { allowInteractive = false }: { allowInteractive?: boolean } = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  // Set once the press fires, so the click and context menu that follow the
  // release don't act on top of the menu we just opened.
  const fired = useRef(false);
  // The down event's own timestamp. The wall-clock timer measures when events
  // were PROCESSED, and a main-thread stall (closing the previous sheet costs
  // ~600ms of it) delays processing: a real 700ms hold can reach JS as a
  // down+up pair milliseconds apart, cancelling the timer at once. The events'
  // hardware timestamps still carry the true story, so release consults them.
  const downStamp = useRef(0);
  // Teardown for the window listeners armed alongside the timer.
  const unwatch = useRef<(() => void) | null>(null);
  // The callback read through a ref, so the window listeners armed at
  // pointerdown always call the current one without being re-bound.
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
    unwatch.current?.();
    unwatch.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  /** The finger has wandered past the slop — this is a scroll or a swipe. */
  const handleMove = useCallback(
    (x: number, y: number) => {
      if (!timer.current || !origin.current) return;
      if (Math.hypot(x - origin.current.x, y - origin.current.y) > LONG_PRESS_SLOP_PX) cancel();
    },
    [cancel],
  );

  /**
   * End of the stream, by release or by cancellation — the same rule for both.
   *
   * A hold the timer never got to finish, whose hardware timestamps already
   * span the threshold, is still a hold: on release because event processing
   * stalled (down and up reached JS together), on cancellation because the
   * platform confiscated a press that had already served its time. Fire late
   * rather than not at all. Anything shorter just disarms.
   */
  const handleEnd = useCallback(
    (timeStamp: number) => {
      if (callback.current && timer.current && timeStamp - downStamp.current >= LONG_PRESS_MS) {
        cancel();
        fired.current = true;
        callback.current();
        return;
      }
      cancel();
    },
    [cancel],
  );

  /**
   * Follow the rest of this pointer's stream on the window (capture phase), so
   * neither an ancestor taking pointer capture nor a handler stopping
   * propagation can strand the armed timer. Scoped to the pointer that armed
   * it, so a second finger elsewhere doesn't end this press.
   */
  const watch = useCallback(
    (id: number | undefined) => {
      unwatch.current?.();
      const mine = (e: PointerEvent) =>
        id === undefined || e.pointerId === undefined || e.pointerId === id;
      const onMove = (e: PointerEvent) => {
        if (mine(e)) handleMove(e.clientX, e.clientY);
      };
      const onEnd = (e: PointerEvent) => {
        if (mine(e)) handleEnd(e.timeStamp);
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onEnd, true);
      window.addEventListener("pointercancel", onEnd, true);
      unwatch.current = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onEnd, true);
        window.removeEventListener("pointercancel", onEnd, true);
      };
    },
    [handleMove, handleEnd],
  );

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (!onLongPress || e.pointerType !== "touch") return;
      if (!allowInteractive && (e.target as HTMLElement).closest(INTERACTIVE)) return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      downStamp.current = e.timeStamp;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        cancel();
        fired.current = true;
        callback.current?.();
      }, LONG_PRESS_MS);
      watch(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => handleMove(e.clientX, e.clientY),
    onPointerUp: (e: React.PointerEvent) => handleEnd(e.timeStamp),
    onPointerCancel: (e: React.PointerEvent) => handleEnd(e.timeStamp),
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
