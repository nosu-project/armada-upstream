import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Grow a textarea to fit its content up to `maxHeight` px, mirroring the chat
 * composer's sizing. Counting `\n` via the `rows` attribute only measures hard
 * line breaks, so a wrapped single-paragraph message collapses to one row —
 * measuring `scrollHeight` sizes to the wrapped visual height instead.
 *
 * Returns a callback ref (not a RefObject) on purpose: an inline edit textarea
 * mounts only when edit mode opens, and entering edit mode doesn't change
 * `value` (it's pre-seeded), so a `value`-keyed effect never fires on that
 * mount. The callback ref resizes the moment the node attaches.
 */
export function useAutosizeTextarea(value: string, maxHeight = 160) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [maxHeight]);

  // Fires on typing / programmatic value changes while the node stays mounted.
  useLayoutEffect(resize, [value, resize]);

  // Fires when the textarea (un)mounts — the case the effect above misses.
  return useCallback(
    (el: HTMLTextAreaElement | null) => {
      ref.current = el;
      resize();
    },
    [resize],
  );
}
