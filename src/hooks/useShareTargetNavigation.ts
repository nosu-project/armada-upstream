import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import {
  hasShareTarget,
  isShareableRoomRoute,
  onLateColdShareRoute,
  resolveNativeShare,
  ShareTarget,
} from "@/lib/shareTarget";
import { signalDeepLinkNavigated } from "@/lib/webReady";

/**
 * Route WARM shares (app already running when the share intent arrives) —
 * the ACTION_SEND sibling of {@link useNotificationNavigation}'s appUrlOpen
 * handling. ShareTargetPlugin fires `shareReceived` from onNewIntent.
 *
 * Navigation goes by the instant, copy-free peek (a Direct Share tap's
 * shortcut id IS the destination route; otherwise the /share picker), so the
 * user isn't parked behind MainActivity's crest gate while a shared video is
 * copied — the payload resolves after, and the destination's composer (or
 * SharePage) picks it up through the share-stash subscription.
 *
 * Cold launches are handled by the module-load peek in `shareTarget.ts` +
 * `HomeRedirect` (same split, and same reasoning, as coldLaunchDeepLink).
 * Must be rendered inside the router so `useNavigate` resolves.
 */
export function useShareTargetNavigation(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!hasShareTarget()) return;
    let cancelled = false;

    const handleShare = async () => {
      try {
        const peek = await ShareTarget.peekShare();
        if (!peek.pending) return;
        const route =
          peek.shortcutId && isShareableRoomRoute(peek.shortcutId)
            ? peek.shortcutId
            : "/share";
        if (!cancelled) navigate(route);
      } finally {
        // MainActivity threw the crest gate over the WebView on the share
        // intent; release it once the destination (or its splash fallback)
        // has painted — signalDeepLinkNavigated waits two rAFs for that.
        // MUST fire here, right after the navigate, NOT after the payload
        // resolve below: checkShare's stream copies can take seconds, and a
        // gate held past its cap reveals the STALE pre-share screen before
        // the router has moved (the exact flash the gate exists to prevent).
        // Signalled even on failure so the gate never sits out its timeout.
        signalDeepLinkNavigated();
      }
      // The payload, off the navigation's critical path: the destination's
      // composer (or SharePage) subscribes to the share stash and picks it
      // up whenever the copies land.
      await resolveNativeShare();
    };

    let handle: { remove: () => void } | undefined;
    ShareTarget.addListener("shareReceived", () => {
      void handleShare().catch(() => undefined);
    })
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);

    // A cold-launch share whose peek resolved only after the guard had
    // released HomeRedirect to the default route: apply its destination like
    // a warm share instead of leaving the stashed payload with no navigation
    // (same shape as useNotificationNavigation's late cold deep link).
    const offLate = onLateColdShareRoute((route) => {
      if (!cancelled) navigate(route);
    });

    return () => {
      cancelled = true;
      offLate();
      handle?.remove();
    };
  }, [navigate]);
}
