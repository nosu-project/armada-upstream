/**
 * Haptics.
 *
 * On the native APK these route through Capacitor's Haptics plugin (the Android
 * System WebView does NOT implement the web Vibration API, so `navigator.vibrate`
 * silently no-ops there). On the web we fall back to the Vibration API when
 * present, and otherwise no-op.
 *
 * All calls are fire-and-forget: the native bridge is async, but callers treat
 * haptics as a side effect, so we swallow the promise and never block on it.
 */

import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

const native = Capacitor.isNativePlatform();

/** Web Vibration API fallback (no-ops in the Android WebView / when absent). */
function webVibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration API unavailable — no-op.
  }
}

/** A light selection tick — toggles, segmented controls, picking an item. */
export function selectionChanged(): void {
  if (native) {
    void Haptics.selectionChanged().catch(() => undefined);
    return;
  }
  webVibrate(10);
}

/** A discrete impact — taps that commit an action, picking up a draggable. */
export function impact(style: "light" | "medium" | "heavy" = "medium"): void {
  if (native) {
    const map = {
      light: ImpactStyle.Light,
      medium: ImpactStyle.Medium,
      heavy: ImpactStyle.Heavy,
    } as const;
    void Haptics.impact({ style: map[style] }).catch(() => undefined);
    return;
  }
  webVibrate(style === "heavy" ? 25 : style === "medium" ? 15 : 8);
}

/** A success/warning/error notification buzz. */
export function notify(type: "success" | "warning" | "error" = "success"): void {
  if (native) {
    const map = {
      success: NotificationType.Success,
      warning: NotificationType.Warning,
      error: NotificationType.Error,
    } as const;
    void Haptics.notification({ type: map[type] }).catch(() => undefined);
    return;
  }
  webVibrate(type === "error" ? [10, 40, 10] : 20);
}
