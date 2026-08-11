import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

/**
 * One shared Capacitor `appStateChange` subscription, fanned out to plain JS
 * listeners.
 *
 * On Android the WebView's own `visibilitychange`/`pagehide` events are not
 * delivered reliably across background/resume transitions (see the
 * focusManager wiring in App.tsx and MainActivity.onResume, which both work
 * around the same defect). Capacitor's `appStateChange` comes from the
 * activity lifecycle instead, so it is the authoritative "the app was
 * backgrounded / resumed" signal for anything that must not depend on the
 * renderer's page-visibility state.
 *
 * The native listener is registered lazily on the first subscribe and only on
 * native platforms; subscribing on web/desktop is a no-op that never fires.
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
