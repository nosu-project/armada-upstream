import { useEffect, useState } from "react";

/** The `sidebar` breakpoint (tailwind.config.ts) for the multi-pane desktop layout. */
const DESKTOP_QUERY = "(min-width: 900px)";

/**
 * Reactive. E.g. auto-dive into a default channel on desktop but not on mobile, where it
 * would skip the channel list.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    // Sync in case it changed between the initial state and the effect.
    setIsDesktop(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isDesktop;
}
