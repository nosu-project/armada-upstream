import { useNativeNotifications } from "@/hooks/useNativeNotifications";

/**
 * Headless mount that keeps the native (APK) background notification service
 * configured with the current user, relays, groups and prefs while the app is
 * open. (Event ingestion from the service lives in the wire — see WireSync.)
 * No UI — the toggle lives in NotificationSettings. Inert on web/PWA.
 *
 * The two things a user has to *answer* — the OS notification permission and
 * the Android battery-optimization exemption — are not asked here. They're
 * steps in the post-login setup flow (see LoginSetup), which explains each one
 * before asking instead of firing a system dialog and a toast at a user who has
 * just logged in.
 */
export function NativeNotifications() {
  useNativeNotifications();
  return null;
}
