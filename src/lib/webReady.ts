import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Native bridge for telling the Android launch splash when the web layer has
 * actually painted, so it can lift at the right moment (see WebReadyPlugin.java
 * + MainActivity's setKeepOnScreenCondition). The native side holds the
 * animated-crest splash across the whole cold start; without this the splash
 * would lift on the WebView's first (blank) paint and flash an empty WebView
 * before React renders.
 */
interface WebReadyPlugin {
  signalReady(): Promise<void>;
  signalDeepLinkNavigated(): Promise<void>;
}

const WebReady = registerPlugin<WebReadyPlugin>("WebReady");

/**
 * Tell native the web layer has painted its first real frame. No-op off
 * Android and fails soft if the native method is missing (older binary), so
 * the native 8s safety timeout still lifts the splash.
 *
 * Call this once, after React has mounted. It waits for two animation frames
 * (commit -> layout/paint) so the signal lands after the browser has actually
 * put content on screen, not merely after the render call returned.
 */
export function signalWebReady(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      WebReady.signalReady().catch(() => {
        // Missing native method / bridge down — native timeout covers it.
      });
    });
  });
}

/**
 * Tell native the SPA has handled a warm deep link, so MainActivity can lift
 * the crest gate it threw over the WebView on the tap's onNewIntent. Waits
 * two animation frames so the destination route (or its splash fallback) is
 * actually painted when the gate lifts. Fails soft — the native gate has its
 * own timeout.
 */
export function signalDeepLinkNavigated(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      WebReady.signalDeepLinkNavigated().catch(() => undefined);
    });
  });
}
