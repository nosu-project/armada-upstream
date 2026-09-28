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
 * Touch-first devices without hover. Use this — not {@link useIsMobile} — to gate touch-only
 * interactions, so a narrow desktop window keeps hover behaviour.
 */
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

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
