import { useLayoutEffect, useRef } from "react";

/**
 * Grow a textarea to fit its content up to `maxHeight` px, mirroring the chat
 * composer's sizing. Counting `\n` via the `rows` attribute only measures hard
 * line breaks, so a wrapped single-paragraph message collapses to one row —
 * measuring `scrollHeight` sizes to the wrapped visual height instead.
 */
export function useAutosizeTextarea(value: string, maxHeight = 160) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);
  return ref;
}
