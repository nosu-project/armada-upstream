import { App as CapacitorApp } from "@capacitor/app";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { isNativeRuntime } from "@/lib/platform";
import { onLateColdLaunchDeepLink } from "@/lib/coldLaunchDeepLink";
import { markDeepLinkNavigation } from "@/lib/deepLinkNav";
import { isRouterPath, pathFromDeepLinkUrl } from "@/lib/deepLinkUrl";
import { isDesktop, onDesktopDeepLink } from "@/lib/desktop";
import { ArmadaPush, hasIosPush } from "@/lib/nativePush";
import { signalDeepLinkNavigated } from "@/lib/webReady";

/**
 * Route WARM deep links (notification taps' `armada://open<path>`, verified App Links) through
 * React Router — never a reload. Cold launches belong to {@link coldLaunchDeepLink} + `HomeRedirect`.
 * Must be rendered inside the router.
 */

/**
 * JS-side bound for the crest gate when the router never visibly commits the link; below the
 * native cap.
 */
const GATE_FALLBACK_MS = 2500;

export function useNotificationNavigation(): void {
  const navigate = useNavigate();
  const location = useLocation();

  // Readable in long-lived listeners without re-registering.
  const locationRef = useRef(location);
  locationRef.current = location;

  // Between navigate() and the router COMMIT: signalling on return lifted the native crest gate
  // onto the previous view, so the signal waits for the location change.
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
      // Android re-shows the IME for a still-focused editor on window focus, over the transition.
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      // Before navigate so the destination's SwipeReveal skips its entrance slide.
      markDeepLinkNavigation();
      const { pathname, search, hash } = locationRef.current;
      if (path === pathname + search + hash) {
        // Already there: nothing will commit, so release the gate now.
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
        // Signal anyway so the gate never sits out its timeout.
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

    // Late-resolving cold-launch URL: apply like a warm link instead of dropping it.
    const offLate = onLateColdLaunchDeepLink((path) => {
      if (!cancelled) applyDeepLink(path);
    });

    // iOS push taps arrive via the notification delegate; warm only (cold taps are read by
    // coldLaunchDeepLink).
    let pushHandle: { remove: () => void } | undefined;
    if (hasIosPush()) {
      ArmadaPush.addListener("pushOpened", ({ path }) => {
        // The gateway picks this field; a protocol-relative "path" would name another origin.
        if (!cancelled && path && isRouterPath(path)) applyDeepLink(path);
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

  // Desktop: in-app clicks on our own host arrive as router paths from the shell.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    const off = onDesktopDeepLink((path) => {
      // Re-guard rather than trust an IPC value to name a route.
      if (cancelled || !path || !isRouterPath(path)) return;
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      const { pathname, search, hash } = locationRef.current;
      if (path === pathname + search + hash) return;
      // Before navigate so SwipeReveal skips its entrance slide.
      markDeepLinkNavigation();
      navigate(path);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [navigate]);
}
