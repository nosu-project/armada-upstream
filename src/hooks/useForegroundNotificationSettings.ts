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
 *
 * THOSE TWO FACTS TOGETHER ARE A TRAP, and it is why {@link isForegroundNotifyReady}
 * exists. The intent defaulting to ON means a profile that has never been asked
 * still reads "on", while `Notification.permission` sits at `"default"` and the
 * notifier can never fire — a feature that looks enabled, is enabled, and does
 * nothing, indefinitely. Permission can only be requested from a user gesture,
 * so the fix isn't to ask on mount: it is that INTENT ALONE IS NEVER THE
 * ANSWER. Every surface asking "is this on?" must ask for both, which is what
 * this module now returns.
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

/** Whether the browser has actually granted permission to notify. */
export function foregroundNotifyGranted(): boolean {
  return notificationsApiAvailable() && Notification.permission === "granted";
}

/**
 * Whether an OS notification would actually appear right now — the user wants
 * them AND the browser has granted permission.
 *
 * The single answer to "is this on?", so no caller can accidentally consult
 * only the intent and report a feature as working when it cannot fire.
 */
export function isForegroundNotifyReady(): boolean {
  return foregroundNotifyIntent() && foregroundNotifyGranted();
}

/**
 * Ask the browser for Notification permission and turn the intent on.
 *
 * MUST be called from a user gesture — every browser refuses otherwise, which
 * is the whole reason this can't happen automatically at boot. Resolves to
 * whether notifications can now fire. Safe to call when already granted (no
 * prompt) or denied (resolves immediately, no prompt).
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
  /**
   * Whether notifications would ACTUALLY fire — the intent plus a granted
   * permission. This, not `intent`, is what a toggle should show: the intent
   * defaults to on, so a profile that has never been prompted would otherwise
   * display an enabled feature that can't fire and gives no hint why.
   */
  enabled: boolean;
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
    // `focus` as well: permission is usually changed in a browser panel that
    // never hides the tab, so visibility alone misses it.
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
      // Ask whenever permission isn't granted, not only when it is exactly
      // "default". Because the toggle now shows intent AND permission, its
      // first use is usually "it reads off because permission was never asked
      // for" rather than a real off→on flip — and the old `=== "default"`
      // guard made that click a no-op. A "denied" request resolves at once
      // without prompting, so covering it costs nothing.
      await enableForegroundNotifications();
      setIntent(true);
      if (apiAvailable) setPermission(Notification.permission);
    },
    [apiAvailable],
  );

  const setPrefs = useCallback((next: PushPrefs) => {
    setPrefsState(next);
    savePrefs(next);
  }, []);

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
