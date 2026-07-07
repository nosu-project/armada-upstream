import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { usePushNotifications } from "@/hooks/usePushNotifications";

/**
 * Headless mount that keeps the web-push registration alive app-wide.
 *
 * Before this, `usePushNotifications` was only mounted by the notification
 * settings page — so its auto-(re)enable and server-record syncs (prefs and
 * per-channel mutes) only ran when the user happened to visit Settings. This
 * keeps the subscription registered and the relay's copy of the prefs/mutes
 * fresh for the whole session. No UI — the toggles live in
 * NotificationSettings. Inert in the native APK (which uses the foreground
 * service path instead — see NativeNotifications).
 */
export function WebPushNotifications() {
  if (isNativeRuntime()) return null;
  return <WebPushBridge />;
}

function WebPushBridge() {
  usePushNotifications();
  return null;
}
