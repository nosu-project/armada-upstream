import { Capacitor, registerPlugin } from "@capacitor/core";

import { coldLaunchPending, onColdLaunchResolved } from "@/lib/coldLaunchDeepLink";
import { coldSharePending, onColdShareResolved } from "@/lib/shareTarget";

/**
 * Bridge telling the Android launch splash when the web layer has really
 * painted (WebReadyPlugin.java + setKeepOnScreenCondition), so it doesn't lift
 * onto a blank WebView.
 */
interface WebReadyPlugin {
  signalReady(): Promise<void>;
  signalDeepLinkNavigated(): Promise<void>;
}

const WebReady = registerPlugin<WebReadyPlugin>("WebReady");

/**
 * Signal first real paint (after two animation frames). Android only; fails
 * soft, leaving the native 8s timeout.
 */
export function signalWebReady(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
  // Hold the splash until the cold-launch deep link/share resolves, else the
  // default route paints first and visibly transitions. Native caps at 8s.
  if (coldLaunchPending() || coldSharePending()) {
    const offs: Array<() => void> = [];
    let sent = false;
    const check = () => {
      if (sent || coldLaunchPending() || coldSharePending()) return;
      sent = true;
      for (const off of offs) off();
      sendReady();
    };
    offs.push(onColdLaunchResolved(check));
    offs.push(onColdShareResolved(check));
    check();
    return;
  }
  sendReady();
}

function sendReady(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      WebReady.signalReady().catch(() => {
        // native timeout covers it
      });
    });
  });
}

/**
 * Tell native a warm deep link was handled so MainActivity lifts its crest
 * gate (after two frames). Fails soft; the gate has its own timeout.
 */
export function signalDeepLinkNavigated(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      WebReady.signalDeepLinkNavigated().catch(() => undefined);
    });
  });
}
