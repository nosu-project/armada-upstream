import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { useNostrPush } from "@/hooks/useNostrPush";
import { useOnboardingActive } from "@/hooks/useOnboarding";
import { requestWebPushOptIn, setWebPushEnable } from "@/lib/webPushPrompt";

/**
 * Headless mount that keeps the web-push registration alive app-wide.
 *
 * Before this, the push hook was only mounted by the notification settings
 * page — so its auto-(re)enable and server-record syncs (prefs and per-channel
 * mutes) only ran when the user happened to visit Settings. This keeps the
 * subscription registered and the server's copy of the prefs/mutes fresh for
 * the whole session. No UI — the toggles live in NotificationSettings. Inert
 * in the native APK (which uses the foreground service path instead — see
 * NativeNotifications).
 *
 * The content-blind nostr-push hook self-gates on `supported`, so this is also
 * inert when no nostr-push server is configured for this build.
 */
export function WebPushNotifications() {
  if (isNativeRuntime()) return null;
  return <WebPushBridge />;
}

function WebPushBridge() {
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
    if (!user || !active.supported || active.permission !== "default") return;
    requestWebPushOptIn();
  }, [onboarding, user, active.supported, active.permission]);

  return null;
}
