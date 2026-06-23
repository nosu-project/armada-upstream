import { useNativeNotifications } from "@/hooks/useNativeNotifications";

/**
 * Headless mount that keeps the native (APK) background notification service
 * configured with the current user, relays, groups and prefs while the app is
 * open. No UI — the toggle lives in NotificationSettings. Inert on web/PWA.
 */
export function NativeNotifications() {
  useNativeNotifications();
  return null;
}
