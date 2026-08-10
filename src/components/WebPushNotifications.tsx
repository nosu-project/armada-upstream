import { type ReactNode, useEffect } from "react";

import { WebPushContext } from "@/contexts/WebPushContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  enableForegroundNotifications,
  notificationsApiAvailable,
} from "@/hooks/useForegroundNotificationSettings";
import { useIosPush } from "@/hooks/useIosPush";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { useNostrPush } from "@/hooks/useNostrPush";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import { hasIosPush } from "@/lib/nativePush";
import { DEFAULT_PUSH_PREFS, type UsePushNotificationsReturn } from "@/lib/pushPrefs";
import { requestWebPushOptIn, setWebPushEnable } from "@/lib/webPushPrompt";

/**
 * Provider that keeps one gateway push controller alive app-wide.
 *
 * Before this, the push hook was only mounted by the notification settings
 * page — so its auto-(re)enable and server-record syncs (prefs and per-channel
 * mutes) only ran when the user happened to visit Settings. Keeping the hook
 * here also prevents Settings from mounting a second controller and racing two
 * VAPID/server syncs.
 *
 * Which controller depends on how this build can be reached, and exactly one is
 * ever mounted: Web Push in a browser, APNs in the iOS app. The Android APK has
 * neither — it runs its own background relay service instead (see
 * NativeNotifications), which needs no third party in the delivery path — so it
 * gets the inert value below. Both real controllers self-gate on `supported`,
 * so this is also inert when no nostr-push gateway is configured for the build.
 */
export function WebPushNotifications({ children }: { children: ReactNode }) {
  // Platform is fixed for the life of the process, so branching on it before
  // the hooks is stable — each branch mounts one component with its own hooks.
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

  // Keep the post-login opt-in step's action pointed at the live hook, so the
  // step's tap runs the current `enable` (fresh prefs/watch set), not a stale
  // closure captured when the step was queued.
  //
  // Where Web Push is unavailable the step still has a job: it offers the
  // in-page notifier's permission instead. That notifier's intent defaults to
  // ON, so without this ask it reads "enabled" from the very first launch while
  // permission sits at "default" and it can never fire — and on desktop, where
  // it is the ONLY notifier, that is every notification.
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

  // Offer a one-time opt-in once a logged-in user could receive notifications
  // but hasn't been asked at OS level yet (permission still "default"). Held
  // while the signup wizard runs so it doesn't paint over profile creation; the
  // onboarding dep re-fires this the moment the wizard finishes. The module
  // guards against re-offering across loads; the wizard surfaces it after sync.
  const foregroundPending = !active.supported
    && notificationsApiAvailable()
    && Notification.permission === "default";
  useEffect(() => {
    if (onboarding || !user) return;
    // Web Push needs its controller ready before the tap can subscribe; the
    // foreground notifier only needs the Notifications API, so it has no such
    // wait — and self-gates to nothing on iOS, where that API exists only for
    // a Home-Screen PWA (see IosNotificationHint).
    const ready = active.supported
      ? active.ready && active.permission === "default"
      : foregroundPending;
    if (!ready) return;
    requestWebPushOptIn();
  }, [onboarding, user, active.supported, active.ready, active.permission, foregroundPending]);

  return <WebPushContext.Provider value={active}>{children}</WebPushContext.Provider>;
}
