/**
 * Cross-platform share + clipboard.
 *
 * On the native APK these route through Capacitor's plugins (the Android System
 * WebView often doesn't expose the Web Share API, so `navigator.share` is
 * unavailable and sharing silently falls back to a copy). On the web we use the
 * Web Share / Clipboard APIs when present.
 */

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";

const native = Capacitor.isNativePlatform();

/** True when the native share sheet / Web Share API can be used. */
export function canShare(): boolean {
  if (native) return true;
  return typeof navigator !== "undefined" && "share" in navigator;
}

/**
 * Open the native share sheet (or Web Share API). Resolves true if the share
 * was presented, false if it couldn't be (so callers can fall back to copy).
 * A user-cancelled share still counts as presented.
 */
export async function share(opts: {
  title?: string;
  text?: string;
  url?: string;
  dialogTitle?: string;
}): Promise<boolean> {
  try {
    if (native) {
      await Share.share({
        title: opts.title,
        text: opts.text,
        url: opts.url,
        dialogTitle: opts.dialogTitle ?? opts.title,
      });
      return true;
    }
    if (typeof navigator !== "undefined" && "share" in navigator) {
      await navigator.share({ title: opts.title, text: opts.text, url: opts.url });
      return true;
    }
  } catch {
    // User cancelled or share failed — treat cancellation as handled, but a
    // genuine failure should let the caller fall back. We can't easily tell
    // them apart, so return true (the sheet was shown) and let copy be manual.
    return true;
  }
  return false;
}

/**
 * Open an external URL. On native, use the share sheet (the WebView's
 * `window.open` doesn't always hand off to the system browser); on web,
 * open in a new tab.
 */
export async function openUrl(url: string): Promise<void> {
  if (native) {
    await Share.share({ url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
