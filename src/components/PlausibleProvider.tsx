import { useEffect, useRef, type ReactNode } from "react";

import { PLAUSIBLE_DOMAIN, PLAUSIBLE_ENDPOINT } from "@/lib/platform";
import { sanitizePlausibleUrl } from "@/lib/plausibleUrl";

interface PlausibleProviderProps {
  children: ReactNode;
}

/**
 * Initializes Plausible Analytics from the build-time platform config.
 *
 * Analytics is OFF unless a hosted deployment set `VITE_PLAUSIBLE_DOMAIN` at
 * build time (see `platform.ts`). The Android APK, Electron desktop app, and
 * `npm run dev` all leave it empty, so the tracker is never even imported and
 * no telemetry is sent — matching Armada's sovereign, no-baked-in-server
 * posture. Plausible is cookieless and does not track individual users.
 *
 * The tracker is lazy-imported so its ~1KB never enters the main bundle for
 * builds with analytics disabled. `init()` may only be called once, so a ref
 * guards against React StrictMode double-invocation.
 *
 * SPA navigations: Armada uses `<BrowserRouter>` (History API), which the
 * tracker's default `autoCapturePageviews` hooks — so client-side route
 * changes are counted without extra wiring.
 *
 * Native shells (Capacitor/Electron): the webview's `location.href` origin
 * isn't `armada.buzz`, so per-page URLs are local; Plausible still attributes
 * events to the configured `domain`. This is inherent to running a web
 * analytics tracker inside a native shell.
 */
export function PlausibleProvider({ children }: PlausibleProviderProps) {
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current || !PLAUSIBLE_DOMAIN) return;
    initializedRef.current = true;

    import("@plausible-analytics/tracker")
      .then(({ init }) => {
        init({
          domain: PLAUSIBLE_DOMAIN,
          ...(PLAUSIBLE_ENDPOINT && { endpoint: PLAUSIBLE_ENDPOINT }),
          // Collapse dynamic routes to their template and strip query/hash so
          // no pubkey, community id, or invite secret is ever reported.
          transformRequest: (payload) => ({
            ...payload,
            u: sanitizePlausibleUrl(payload.u),
          }),
        });
      })
      .catch((err) => {
        console.error("Failed to initialize Plausible analytics", err);
      });
  }, []);

  return <>{children}</>;
}
