import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

import { useNativeNotifications } from "@/hooks/useNativeNotifications";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useToast } from "@/hooks/useToast";
import { ToastAction } from "@/components/ui/toast";
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from "@/lib/nativeNotifications";

/**
 * Timestamp (ms) of the last battery-exemption nudge. Without the exemption,
 * Doze tears the persistent relay websockets down and the OS refuses
 * background foreground-service starts, so the boot/watchdog recovery paths
 * can't bring the service back — this is the single most important lever for
 * reliable background notifications. We re-nudge periodically (not once-ever)
 * until it's granted, but no more than once per NUDGE_INTERVAL_MS so it
 * doesn't nag on every launch. The warning in notification settings remains
 * available for users who keep declining.
 */
const BATTERY_NUDGE_KEY = "armada:battery-exemption-nudged-at";
const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Headless mount that keeps the native (APK) background notification service
 * configured with the current user, relays, groups and prefs while the app is
 * open. (Event ingestion from the service lives in the wire — see WireSync.)
 * No UI — the toggle lives in NotificationSettings. Inert on web/PWA.
 *
 * Also surfaces the Android battery-optimization problem up front: when
 * background notifications are on but Armada isn't exempt from battery
 * optimization (fresh install), Doze will tear down the persistent relay
 * websockets and notifications silently stop. Rather than hiding that in
 * settings, show a one-time toast with a one-tap fix.
 */
export function NativeNotifications() {
  const { enabled } = useNativeNotifications();

  const { user } = useCurrentUser();
  const { toast } = useToast();

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return;
    if (!user || !enabled) return;
    const lastNudged = Number(localStorage.getItem(BATTERY_NUDGE_KEY)) || 0;
    if (Date.now() - lastNudged < NUDGE_INTERVAL_MS) return;

    let cancelled = false;

    (async () => {
      const exempt = await isIgnoringBatteryOptimizations();
      if (cancelled || exempt) return;

      localStorage.setItem(BATTERY_NUDGE_KEY, String(Date.now()));
      toast({
        title: "Notifications may be unreliable",
        description: (
          <div className="space-y-3">
            <p>
              Battery optimization can cut Armada&rsquo;s background connection.
              Allow background usage for dependable notifications.
            </p>
            {/* Rendered below the text instead of in the side action slot,
                styled as a primary pill. ToastAction still auto-dismisses. */}
            <ToastAction
              altText="Allow background usage"
              onClick={() => {
                requestIgnoreBatteryOptimizations().catch(() => {});
              }}
              className="rounded-full px-5 h-9 border-transparent bg-primary text-primary-foreground font-medium transition-colors hover:bg-primary/90"
            >
              Allow background usage
            </ToastAction>
          </div>
        ),
        duration: 15_000,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [user, enabled, toast]);

  return null;
}
