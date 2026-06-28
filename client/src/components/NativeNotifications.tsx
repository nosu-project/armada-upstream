import { useNativeEventFeed } from "@/hooks/useNativeEventFeed";
import { useNativeNotifications } from "@/hooks/useNativeNotifications";

/**
 * Headless mount that keeps the native (APK) background notification service
 * configured with the current user, relays, groups and prefs while the app is
 * open, and feeds the events it receives straight into the WebView's store so
 * chat is instantly up to date. No UI — the toggle lives in NotificationSettings.
 * Inert on web/PWA.
 */
export function NativeNotifications() {
  useNativeNotifications();
  useNativeEventFeed();
  return null;
}
