import { useCallback, useEffect, useState } from "react";

import { DEFAULT_PUSH_PREFS, type PushPrefs } from "@/lib/pushPrefs";

/**
 * Foreground (in-page) notification enablement.
 *
 * This is the client-side notifier that runs while Armada is OPEN — separate
 * from Web Push (which delivers with the tab closed via the relay gateway) and
 * the native Android service. It fires a real OS `new Notification(...)` for
 * incoming messages/mentions/DMs whether the tab is focused or backgrounded
 * (except for the conversation currently on screen). See
 * useForegroundNotifications.
 *
 * Crucially it needs NO push gateway and NO Push API — only the Notifications
 * API + permission — so it works in browsers where Web Push is unavailable
 * (e.g. Brave with Google push services disabled), which otherwise get no
 * notifications at all while the app is open in the background.
 *
 * The user's intent (the master on/off wish) is stored locally, defaulting ON
 * (opt-out), mirroring the push intent. Nothing fires until the browser grants
 * Notification permission.
 */

/** localStorage key for the foreground-notification intent (master on/off). */
const INTENT_KEY = "armada:foreground-notif-intent";
/** Shared per-type preferences key (also used by Web Push / native). */
const PREFS_KEY = "armada:push-prefs";

/** Whether the Notifications API is available (required to notify). */
export function notificationsApiAvailable(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function loadIntent(): boolean {
  try {
    const raw = localStorage.getItem(INTENT_KEY);
    if (raw === null) return true; // on by default
    return raw === "true";
  } catch {
    return true;
  }
}

function saveIntent(on: boolean): void {
  try {
    localStorage.setItem(INTENT_KEY, String(on));
  } catch {
    // ignore
  }
}

/** Read the current intent without a hook (for the notifier). */
export function foregroundNotifyIntent(): boolean {
  return loadIntent();
}

function loadPrefs(): PushPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PUSH_PREFS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_PUSH_PREFS };
}

function savePrefs(prefs: PushPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export interface UseForegroundNotificationSettingsReturn {
  /** Whether the Notifications API is present (OS notifications possible). */
  apiAvailable: boolean;
  /** Current Notification permission (`"default"` when the API is absent). */
  permission: NotificationPermission;
  /** The user's master on/off wish for foreground notifications. */
  intent: boolean;
  /** Set the master wish; when turning on, prompts for permission if needed. */
  setEnabled: (on: boolean) => Promise<void>;
  /** The shared per-type preferences. */
  prefs: PushPrefs;
  /** Update the per-type preferences (persisted to the shared key). */
  setPrefs: (next: PushPrefs) => void;
}

/**
 * Settings-surface control for the foreground notifier. Turning it on requests
 * Notification permission (a user gesture — call from a click handler) so the
 * notifier can fire OS notifications.
 */
export function useForegroundNotificationSettings(): UseForegroundNotificationSettingsReturn {
  const apiAvailable = notificationsApiAvailable();
  const [permission, setPermission] = useState<NotificationPermission>(
    apiAvailable ? Notification.permission : "default",
  );
  const [intent, setIntent] = useState<boolean>(loadIntent);
  const [prefs, setPrefsState] = useState<PushPrefs>(loadPrefs);

  // Keep the shown permission fresh (the user may change it in browser UI, or
  // grant it via the web-push toggle elsewhere).
  useEffect(() => {
    if (!apiAvailable) return;
    const sync = () => setPermission(Notification.permission);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [apiAvailable]);

  const setEnabled = useCallback(
    async (on: boolean) => {
      saveIntent(on);
      setIntent(on);
      if (on && apiAvailable && Notification.permission === "default") {
        try {
          const perm = await Notification.requestPermission();
          setPermission(perm);
        } catch {
          // Permission request unavailable (e.g. insecure context) — leave
          // permission as-is; the notifier simply won't fire.
        }
      }
    },
    [apiAvailable],
  );

  const setPrefs = useCallback((next: PushPrefs) => {
    setPrefsState(next);
    savePrefs(next);
  }, []);

  return { apiAvailable, permission, intent, setEnabled, prefs, setPrefs };
}
