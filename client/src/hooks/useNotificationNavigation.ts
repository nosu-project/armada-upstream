import { App as CapacitorApp } from "@capacitor/app";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { pathFromDeepLinkUrl } from "@/lib/deepLinkUrl";

/**
 * Route WARM deep links (app already running) to the in-app chat via
 * React Router — never a full document reload.
 *
 * Two sources land here while the app is running: notification taps (the
 * Android PendingIntent carries an `armada://open<path>` data URI) and
 * verified App Links (`https://armada.buzz/<path>`, e.g. a tapped invite
 * link). Capacitor's @capacitor/app plugin fires `appUrlOpen` with the URL; we
 * parse the path and `navigate(path)` — a soft navigation that reuses the warm
 * IndexedDB, query cache, and live subscriptions (vs. `window.location.href`,
 * which reloads the document and cold-boots the whole app).
 *
 * COLD launches (process swiped out) are handled separately by
 * {@link coldLaunchDeepLink} + `HomeRedirect`: the launch URL resolves async and
 * would race the router's default redirect, so it's read once at startup and
 * `HomeRedirect` waits for it. Keeping cold-launch ownership there (not here)
 * avoids a double navigation.
 *
 * Must be rendered inside the router so `useNavigate` resolves.
 */

export function useNotificationNavigation(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let cancelled = false;

    let handle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      const path = pathFromDeepLinkUrl(url);
      if (!cancelled && path) navigate(path);
    })
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [navigate]);
}
