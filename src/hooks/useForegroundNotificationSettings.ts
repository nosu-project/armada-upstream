import { useCallback, useEffect, useState } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { savePushPrefs, type PushPrefs } from "@/lib/pushPrefs";

/**
 * Foreground (in-page) notifications while Armada is open, separate from Web Push and the
 * native Android service. Needs only the Notifications API + permission, so it works where Web
 * Push doesn't (e.g. Brave without Google push services).
 * The intent defaults ON, but permission can only be requested from a user gesture — so intent
 * alone is never the answer; use {@link isForegroundNotifyReady}.
 */

const INTENT_KEY = "armada:foreground-notif-intent";

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

export function foregroundNotifyIntent(): boolean {
  return loadIntent();
}

export function foregroundNotifyGranted(): boolean {
  return notificationsApiAvailable() && Notification.permission === "granted";
}

/** Intent AND granted permission: the single answer to "is this on?". */
export function isForegroundNotifyReady(): boolean {
  return foregroundNotifyIntent() && foregroundNotifyGranted();
}

/**
 * MUST be called from a user gesture. Resolves to whether notifications can now fire; no
 * prompt when already granted or denied.
 */
export async function enableForegroundNotifications(): Promise<boolean> {
  if (!notificationsApiAvailable()) return false;
  saveIntent(true);
  if (Notification.permission === "granted") return true;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    // Permission request unavailable (e.g. insecure context).
    return false;
  }
}

export interface UseForegroundNotificationSettingsReturn {
  apiAvailable: boolean;
  /** `"default"` when the API is absent. */
  permission: NotificationPermission;
  intent: boolean;
  /** Intent plus granted permission — what a toggle should show, since intent defaults on. */
  enabled: boolean;
  setEnabled: (on: boolean) => Promise<void>;
  prefs: PushPrefs;
  setPrefs: (next: PushPrefs) => void;
}

/** Turning it on requests permission, so call from a click handler. */
export function useForegroundNotificationSettings(): UseForegroundNotificationSettingsReturn {
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();
  const apiAvailable = notificationsApiAvailable();
  const [permission, setPermission] = useState<NotificationPermission>(
    apiAvailable ? Notification.permission : "default",
  );
  const [intent, setIntent] = useState<boolean>(loadIntent);
  const prefs = config.pushPrefs;

  // Permission may change in browser UI or via the web-push toggle.
  useEffect(() => {
    if (!apiAvailable) return;
    const sync = () => setPermission(Notification.permission);
    document.addEventListener("visibilitychange", sync);
    // `focus` too: permission panels don't hide the tab.
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
    };
  }, [apiAvailable]);

  const setEnabled = useCallback(
    async (on: boolean) => {
      if (!on) {
        saveIntent(false);
        setIntent(false);
        return;
      }
      // Ask whenever not granted (not only "default"): "denied" resolves without prompting.
      await enableForegroundNotifications();
      setIntent(true);
      if (apiAvailable) setPermission(Notification.permission);
    },
    [apiAvailable],
  );

  const setPrefs = useCallback((next: PushPrefs) => {
    savePushPrefs(next, user?.pubkey);
    updateConfig((current) => ({ ...current, pushPrefs: next }));
  }, [updateConfig, user?.pubkey]);

  return {
    apiAvailable,
    permission,
    intent,
    enabled: intent && permission === "granted",
    setEnabled,
    prefs,
    setPrefs,
  };
}
