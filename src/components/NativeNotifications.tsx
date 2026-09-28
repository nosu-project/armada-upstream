import { useNativeNotifications } from "@/hooks/useNativeNotifications";

/**
 * Keeps the native (APK) notification service configured while the app is
 * open. Inert on web. Permission prompts live in LoginSetup, not here.
 */
export function NativeNotifications() {
  useNativeNotifications();
  return null;
}
