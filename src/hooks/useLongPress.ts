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
 * is not a wrong menu — it is a press that does nothing. Exactly ONE thing
 * disqualifies one: the finger travelling past {@link LONG_PRESS_SLOP_PX}. A
 * bare `pointercancel` does not, since the platform fires it the moment it
 * claims a gesture. Nothing else may be consulted at fire time — a check that
 * runs a beat AFTER the hold completes can only ever swallow a press the user
 * has already committed to, which is the one failure this must not have.
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
  // Set once the finger travels past the slop. Only then is a `pointercancel`
  // evidence of a scroll rather than of the platform helping itself to the hold.
  const drifted = useRef(false);
  // The down event's own timestamp. The wall-clock timer measures when events
  // were PROCESSED, and a main-thread stall (closing the previous sheet costs
  // ~600ms of it) delays processing: a real 700ms hold can reach JS as a
  // down+up pair milliseconds apart, cancelling the timer at once. The events'
  // hardware timestamps still carry the true story, so release consults them.
  const downStamp = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (!onLongPress || e.pointerType !== "touch") return;
      if (!allowInteractive && (e.target as HTMLElement).closest(INTERACTIVE)) return;
      fired.current = false;
      drifted.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      downStamp.current = e.timeStamp;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        origin.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!timer.current || !origin.current) return;
      const { x, y } = origin.current;
      if (Math.hypot(e.clientX - x, e.clientY - y) > LONG_PRESS_SLOP_PX) {
        drifted.current = true;
        cancel();
      }
    },
    onPointerUp: (e: React.PointerEvent) => {
      // A hold the timer never got to finish — event processing stalled, so
      // the down and this up reached JS together — is still a hold: the
      // hardware timestamps prove it out. Fire late rather than not at all.
      if (onLongPress && timer.current && !drifted.current && e.timeStamp - downStamp.current >= LONG_PRESS_MS) {
        cancel();
        fired.current = true;
        onLongPress();
        return;
      }
      cancel();
    },
    onPointerCancel: (e: React.PointerEvent) => {
      // `pointercancel` is the platform announcing it has TAKEN the gesture —
      // for a scroll probe, a text selection, a callout, an image drag. Treating
      // that as "no long press" hands the feature to whichever heuristic fires
      // first, which is why a hold intermittently did nothing at all. Only a
      // gesture that has already moved is evidence of a scroll; a finger that
      // stayed put is a hold being confiscated, so keep the timer running — and
      // if the hardware timestamps say the hold already served its time, fire
      // here and now.
      if (onLongPress && timer.current && !drifted.current && e.timeStamp - downStamp.current >= LONG_PRESS_MS) {
        cancel();
        fired.current = true;
        onLongPress();
        return;
      }
      if (drifted.current) cancel();
    },
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
