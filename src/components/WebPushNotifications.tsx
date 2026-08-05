import { type ReactNode, useEffect } from "react";

import { WebPushContext } from "@/contexts/WebPushContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { useNostrPush } from "@/hooks/useNostrPush";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import { DEFAULT_PUSH_PREFS, type UsePushNotificationsReturn } from "@/lib/pushPrefs";
import { requestWebPushOptIn, setWebPushEnable } from "@/lib/webPushPrompt";

/**
 * Provider that keeps one web-push controller alive app-wide.
 *
 * Before this, the push hook was only mounted by the notification settings
 * page — so its auto-(re)enable and server-record syncs (prefs and per-channel
 * mutes) only ran when the user happened to visit Settings. Keeping the hook
 * here also prevents Settings from mounting a second controller and racing two
 * VAPID/server syncs. Inert in the native APK (which uses the foreground
 * service path instead — see NativeNotifications).
 *
 * The content-blind nostr-push hook self-gates on `supported`, so this is also
 * inert when no nostr-push server is configured for this build.
 */
export function WebPushNotifications({ children }: { children: ReactNode }) {
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
  const { user } = useCurrentUser();
  const onboarding = useOnboardingActive();

  // Keep the post-login opt-in step's action pointed at the live hook, so the
  // step's tap runs the current `enable` (fresh prefs/watch set), not a stale
  // closure captured when the step was queued.
  useEffect(() => {
    setWebPushEnable(active.enable);
    return () => setWebPushEnable(null);
  }, [active.enable]);

  // Offer a one-time opt-in once a logged-in user could receive web push but
  // hasn't been asked at OS level yet (permission still "default"). Held while
  // the signup wizard runs so it doesn't paint over profile creation; the
  // onboarding dep re-fires this the moment the wizard finishes. The module
  // guards against re-offering across loads; the wizard surfaces it after sync.
  useEffect(() => {
    if (onboarding) return;
    if (!user || !active.supported || !active.ready || active.permission !== "default") return;
    requestWebPushOptIn();
  }, [onboarding, user, active.supported, active.ready, active.permission]);

  return <WebPushContext.Provider value={active}>{children}</WebPushContext.Provider>;
}
