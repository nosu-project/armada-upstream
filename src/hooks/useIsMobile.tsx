import { useEffect, useState, useSyncExternalStore } from "react"

/** Matches the `md` breakpoint in tailwind.config.ts (768px). Hardcoded to avoid pulling the entire Tailwind config + plugins into the client bundle. */
const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(window.innerWidth < MOBILE_BREAKPOINT);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    }
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

/**
 * Touch-first devices: the PRIMARY pointer is a finger. Use this — not {@link useIsMobile} — to
 * gate touch-only interactions, so a narrow desktop window keeps hover behaviour. Not also
 * `(hover: none)`: some Android WebViews report `hover: hover` on a phone. Keep in step with
 * the `touch:` variant (tailwind.config.ts) and index.css.
 */
const TOUCH_QUERY = "(pointer: coarse)";

// One shared query list + listener (per-row matchMedia showed up in profiles). Keyed on
// `window.matchMedia` so a test stub is asked afresh.
let touchQuery: { from: typeof window.matchMedia; mql: MediaQueryList } | undefined;
const touchMql = () => {
  if (touchQuery?.from !== window.matchMedia) {
    touchQuery = { from: window.matchMedia, mql: window.matchMedia(TOUCH_QUERY) };
  }
  return touchQuery.mql;
};
const subscribeTouch = (onChange: () => void) => {
  const mql = touchMql();
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
};
const touchSnapshot = () => touchMql().matches;

export function useIsTouch(): boolean {
  return useSyncExternalStore(subscribeTouch, touchSnapshot, () => false);
}
