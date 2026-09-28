import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Grow a textarea to fit its content up to `maxHeight` px via `scrollHeight`
 * (wrapped lines count). Returns a callback ref so it also resizes on mount,
 * which a `value`-keyed effect misses for pre-seeded edit fields.
 */
export function useAutosizeTextarea(value: string, maxHeight = 160) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [maxHeight]);

  useLayoutEffect(resize, [value, resize]);

  return useCallback(
    (el: HTMLTextAreaElement | null) => {
      ref.current = el;
      resize();
    },
    [resize],
  );
}
