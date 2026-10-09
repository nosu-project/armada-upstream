import { useMemo, useRef } from "react";

/**
 * For a hover-toolbar trigger: a popover/menu opened by pointer doesn't hand
 * focus back to its trigger on close, since a focused trigger holds the toolbar
 * (focus-within) and its tooltip up after the pointer has left. Keyboard opens
 * keep Radix's restore.
 */
export function usePointerOpened() {
  const byPointer = useRef(false);
  return useMemo(
    () => ({
      triggerProps: {
        onPointerDown: () => {
          byPointer.current = true;
        },
        onKeyDown: () => {
          byPointer.current = false;
        },
      },
      onCloseAutoFocus: (e: Event) => {
        if (byPointer.current) e.preventDefault();
      },
    }),
    [],
  );
}
