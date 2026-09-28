import { useState } from "react";

import { useOverlayBack } from "@/hooks/useAndroidBack";
import { useIsDesktop } from "@/hooks/useIsDesktop";

/**
 * Open state of the mobile member overlay — the roster that slides over the
 * chat pane below the `sidebar` breakpoint (Concord and NIP-29 pages alike).
 * The desktop roster is a persisted preference (`memberListVisible`) and is
 * not this.
 *
 * The overlay lives INSIDE the chat pane, so it must never outlive the chat
 * it covers:
 *
 * - `contextKey` names the room it was opened over; a new key closes it
 *   during render, so the new room never paints under the old overlay.
 * - `listOpen` is the drill-down's revealed channel list. Revealing the list
 *   (back, swipe, the header chevron) closes it, so tapping a channel —
 *   including the one already open, which changes no key — brings back the
 *   messages rather than the overlay.
 * - While open on the narrow layout, back (Android's and the browser's)
 *   closes it first, like any other sheet, instead of reaching the
 *   drill-down's reveal underneath.
 */
export function useMobileMembersOverlay(
  contextKey: string,
  listOpen: boolean,
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState(contextKey);
  if (context !== contextKey) {
    setContext(contextKey);
    setOpen(false);
  } else if (open && listOpen) {
    setOpen(false);
  }

  const isDesktop = useIsDesktop();
  useOverlayBack(() => {
    setOpen(false);
    return true;
  }, open && !isDesktop);

  return [open, setOpen];
}
