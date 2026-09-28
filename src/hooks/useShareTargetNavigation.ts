import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import {
  hasShareTarget,
  onLateColdShareRoute,
  resolveNativeShare,
  ShareTarget,
  shortcutShareRoute,
} from "@/lib/shareTarget";
import { signalDeepLinkNavigated } from "@/lib/webReady";

/**
 * Route WARM shares (ACTION_SEND via `shareReceived`), the share sibling of
 * {@link useNotificationNavigation}. Navigates on the instant peek (a Direct Share shortcut id IS
 * the route; else /share); the payload resolves afterwards via the share stash. Cold launches:
 * `shareTarget.ts` + `HomeRedirect`. Must be inside the router.
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
        const route = (peek.shortcutId && shortcutShareRoute(peek.shortcutId)) || "/share";
        if (!cancelled) navigate(route);
      } finally {
        // Release the crest gate right after navigate, NOT after the payload resolves (copies can take
        // seconds and would reveal the stale screen). Signalled even on failure.
        signalDeepLinkNavigated();
      }
      // Off the critical path; the destination picks it up from the share stash.
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

    // Late-resolving cold-launch share: navigate like a warm one.
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
