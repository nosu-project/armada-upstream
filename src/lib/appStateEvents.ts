import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

/**
 * One shared Capacitor `appStateChange` subscription, fanned out to listeners.
 * Android WebView doesn't reliably deliver `visibilitychange`/`pagehide` across
 * background/resume, so this is the authoritative signal. No-op on web/desktop.
 */

type AppStateListener = (isActive: boolean) => void;

const listeners = new Set<AppStateListener>();
let registered = false;

/** Run `cb` on every app foreground/background flip. Returns unsubscribe. */
export function onAppStateChange(cb: AppStateListener): () => void {
  if (!registered && Capacitor.isNativePlatform()) {
    registered = true;
    void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      for (const l of [...listeners]) l(isActive);
    });
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
