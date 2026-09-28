import { useState } from "react";

import { useOverlayBack } from "@/hooks/useAndroidBack";
import { useIsDesktop } from "@/hooks/useIsDesktop";

/**
 * Open state of the mobile member overlay (below the `sidebar` breakpoint; the desktop roster
 * is `memberListVisible`). It must never outlive the chat it covers: a new `contextKey` closes it
 * during render, revealing the list (`listOpen`) closes it, and back closes it first.
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
