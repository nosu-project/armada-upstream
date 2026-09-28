import { type ReactNode, useEffect } from "react";

import { WebPushContext } from "@/contexts/WebPushContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  enableForegroundNotifications,
  notificationsApiAvailable,
} from "@/hooks/useForegroundNotificationSettings";
import { useIosPush } from "@/hooks/useIosPush";
import { isNativeRuntime } from "@/lib/platform";
import { useNostrPush } from "@/hooks/useNostrPush";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import { hasNappPush } from "@/lib/nappPush";
import { hasIosPush } from "@/lib/nativePush";
import { DEFAULT_PUSH_PREFS, type UsePushNotificationsReturn } from "@/lib/pushPrefs";
import { requestWebPushOptIn, setWebPushEnable } from "@/lib/webPushPrompt";

/**
 * One app-wide push controller: `useNostrPush` in a browser (Web Push, or
 * `window.napp.push` under Tenna), APNs in the iOS app, inert on Android
 * (NativeNotifications) or without a push gateway. Keeps auto-(re)enable
 * running outside Settings without racing a second controller.
 */
export function WebPushNotifications({ children }: { children: ReactNode }) {
  // Platform is fixed per process, so branching before hooks is stable.
  if (hasNappPush()) return <WebPushBridge>{children}</WebPushBridge>;
  if (hasIosPush()) return <IosPushBridge>{children}</IosPushBridge>;
  if (isNativeRuntime()) {
    const unavailable: UsePushNotificationsReturn = {
      supported: false,
      unavailableReason: "native-runtime",
      ready: false,
      permission: "default",
      enabled: false,
      busy: false,
      prefs: DEFAULT_PUSH_PREFS,
      enable: async () => {},
      disable: async () => {},
      setPrefs: async () => {},
      retry: () => {},
    };
    return <WebPushContext.Provider value={unavailable}>{children}</WebPushContext.Provider>;
  }
  return <WebPushBridge>{children}</WebPushBridge>;
}

function WebPushBridge({ children }: { children: ReactNode }) {
  const active = useNostrPush();
  return <PushBridge active={active}>{children}</PushBridge>;
}

function IosPushBridge({ children }: { children: ReactNode }) {
  const active = useIosPush();
  return <PushBridge active={active}>{children}</PushBridge>;
}

function PushBridge(
  { active, children }: { active: UsePushNotificationsReturn; children: ReactNode },
) {
  const { user } = useCurrentUser();
  const onboarding = useOnboardingActive();

  // Point the opt-in step at the live `enable`, not a stale closure. Without
  // Web Push the step asks for the in-page notifier's permission, whose intent
  // defaults ON and would otherwise never fire (desktop's only notifier).
  useEffect(() => {
    if (active.supported) {
      setWebPushEnable(active.enable, "push");
    } else {
      setWebPushEnable(async () => {
        await enableForegroundNotifications();
      }, "foreground");
    }
    return () => setWebPushEnable(null);
  }, [active.supported, active.enable]);

  // One-time opt-in while permission is "default"; held during the signup wizard.
  const foregroundPending = !active.supported
    && notificationsApiAvailable()
    && Notification.permission === "default";
  useEffect(() => {
    if (onboarding || !user) return;
    // Web Push needs its controller ready; the foreground notifier doesn't.
    const ready = active.supported
      ? active.ready && active.permission === "default"
      : foregroundPending;
    if (!ready) return;
    requestWebPushOptIn();
  }, [onboarding, user, active.supported, active.ready, active.permission, foregroundPending]);

  return <WebPushContext.Provider value={active}>{children}</WebPushContext.Provider>;
}
