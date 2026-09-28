import { useEffect, useRef, type ReactNode } from "react";

import { PLAUSIBLE_DOMAIN, PLAUSIBLE_ENDPOINT } from "@/lib/platform";
import { sanitizePlausibleUrl } from "@/lib/plausibleUrl";

interface PlausibleProviderProps {
  children: ReactNode;
}

/**
 * Plausible Analytics, OFF unless the build sets `VITE_PLAUSIBLE_DOMAIN` (see
 * `platform.ts`); otherwise the tracker is never imported. `init()` may run
 * only once, hence the StrictMode ref guard. Pageviews auto-capture via the History API.
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
          // Collapse routes to templates and strip query/hash so no pubkey, community
          // id or invite secret is ever reported.
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
