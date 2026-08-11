import { App as CapacitorApp } from "@capacitor/app";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { onLateColdLaunchDeepLink } from "@/lib/coldLaunchDeepLink";
import { markDeepLinkNavigation } from "@/lib/deepLinkNav";
import { pathFromDeepLinkUrl } from "@/lib/deepLinkUrl";
import { ArmadaPush, hasIosPush } from "@/lib/nativePush";
import { signalDeepLinkNavigated } from "@/lib/webReady";

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

/** Old worst case for the crest gate; the JS-side bound when the router never
 * visibly commits the deep link (a no-op navigate the equality check missed,
 * a guard redirecting back to the same location). Below the native cap so the
 * gate still lifts on our schedule, not the deadline's. */
const GATE_FALLBACK_MS = 2500;

export function useNotificationNavigation(): void {
  const navigate = useNavigate();
  const location = useLocation();

  // The current location, readable inside long-lived listeners without
  // re-registering them per navigation.
  const locationRef = useRef(location);
  locationRef.current = location;

  // True between a deep-link navigate() and the router COMMITTING it.
  // MainActivity throws the native crest gate over the WebView on a warm
  // deep-link intent, and it lifts on signalDeepLinkNavigated — but signalling
  // when navigate() merely RETURNED lifted it onto the previous view
  // mid-transition, because the commit can trail the call by a lazy chunk
  // load or a heavy destination mount. This flag defers the signal to the
  // location change (the commit); signalDeepLinkNavigated's own double-rAF
  // then lands it after that commit has painted.
  const gatePending = useRef(false);
  useEffect(() => {
    if (!gatePending.current) return;
    gatePending.current = false;
    signalDeepLinkNavigated();
  }, [location]);

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let cancelled = false;

    const applyDeepLink = (path: string) => {
      // Mark before the navigate so the destination's SwipeReveal, mounting
      // in this very commit, sees it and skips its entrance slide.
      markDeepLinkNavigation();
      const { pathname, search, hash } = locationRef.current;
      if (path === pathname + search + hash) {
        // Already there: navigate() would commit nothing, so the location
        // effect above would never fire and the gate would sit out the
        // native cap. Release it now.
        signalDeepLinkNavigated();
        return;
      }
      gatePending.current = true;
      navigate(path);
      window.setTimeout(() => {
        if (gatePending.current) {
          gatePending.current = false;
          signalDeepLinkNavigated();
        }
      }, GATE_FALLBACK_MS);
    };

    let handle: { remove: () => void } | undefined;
    CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      const path = pathFromDeepLinkUrl(url);
      if (cancelled || !path) {
        // Parsed to nothing (or this hook instance is gone): signal anyway,
        // so the gate never sits out its full timeout.
        signalDeepLinkNavigated();
        return;
      }
      applyDeepLink(path);
    })
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);

    // A cold-launch URL that resolved only after the guard had released
    // HomeRedirect to the default route: apply it like a warm deep link
    // instead of dropping the tap on the floor.
    const offLate = onLateColdLaunchDeepLink((path) => {
      if (!cancelled) applyDeepLink(path);
    });

    // iOS push taps arrive on the notification delegate rather than as a URL,
    // so they are their own listener rather than another `appUrlOpen` source.
    // Only the WARM case is here: a tap that launched the process is read by
    // coldLaunchDeepLink, together with the launch URL, so both settle the one
    // race against HomeRedirect. (There is no Android crest gate on iOS; the
    // signal calls inside applyDeepLink are no-ops there.)
    let pushHandle: { remove: () => void } | undefined;
    if (hasIosPush()) {
      ArmadaPush.addListener("pushOpened", ({ path }) => {
        if (!cancelled && path) applyDeepLink(path);
      })
        .then((h) => {
          if (cancelled) h.remove();
          else pushHandle = h;
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
      offLate();
      handle?.remove();
      pushHandle?.remove();
    };
  }, [navigate]);
}
