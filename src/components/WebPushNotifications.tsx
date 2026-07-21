import { isNativeRuntime } from "@/hooks/useNativeNotifications";
import { useNostrPush } from "@/hooks/useNostrPush";
import { usePushNotifications } from "@/hooks/usePushNotifications";

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
 * Both web-push hooks are mounted and self-gate on `supported`: the
 * content-blind nostr-push path when a server is configured for this build,
 * otherwise the legacy relay-gateway path. Exactly one is ever active.
 */
export function WebPushNotifications() {
  if (isNativeRuntime()) return null;
  return <WebPushBridge />;
}

function WebPushBridge() {
  usePushNotifications();
  useNostrPush();
  return null;
}
