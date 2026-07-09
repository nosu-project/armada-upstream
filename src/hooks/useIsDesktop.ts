import { useEffect, useState } from "react";

/**
 * The `sidebar` breakpoint (tailwind.config.ts) at which the app switches from
 * a single-pane mobile drill-down to the multi-pane desktop layout (server rail
 * + channel sidebar + chat all visible at once).
 */
const DESKTOP_QUERY = "(min-width: 900px)";

/**
 * True when the viewport is at/above the `sidebar` breakpoint — i.e. the
 * desktop multi-pane layout is showing rather than the mobile single-pane
 * drill-down. Reactive: updates on resize/orientation change.
 *
 * Use this to branch behaviour that differs by layout, e.g. auto-diving into a
 * default channel on desktop (where the channel list stays visible beside the
 * chat) but NOT on mobile (where it would skip the channel list entirely).
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    // Sync immediately in case it changed between the initial state and effect.
    setIsDesktop(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isDesktop;
}
