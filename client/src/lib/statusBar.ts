/**
 * Native status / navigation bar tinting (Capacitor APK only).
 *
 * Armada is edge-to-edge with a transparent status bar (the SafeArea plugin
 * owns the insets), so the WebView paints under the bars. But the system-drawn
 * *content* of the status bar (clock, icons) and the gesture pill still need a
 * light/dark style that contrasts with the app's current theme background —
 * otherwise a light theme shows white status-bar icons on a near-white app
 * (invisible), or vice versa. On the web these all no-op.
 *
 * Driven from `useTheme.paint()` so every theme switch retints the bars.
 */

import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

const native = Capacitor.isNativePlatform();

/** Parse an `"H S% L%"` HSL string and decide if it reads as a dark color. */
function isDarkHsl(hsl: string): boolean {
  const parts = String(hsl).trim().replace(/%/g, "").split(/\s+/).map(Number);
  const l = parts[2];
  if (Number.isNaN(l)) return true;
  // Lightness threshold mirrors theme.js's perceptual `isDark` closely enough
  // for the binary status-bar style decision.
  return l < 45;
}

/**
 * Sync the native status bar style to the app theme. `background` is the
 * theme's `--background` core color as an `"H S% L%"` HSL string.
 *
 * - Dark background → `Style.Dark` (light status-bar icons).
 * - Light background → `Style.Light` (dark status-bar icons).
 *
 * Note Capacitor's `Style` is named from the *background*'s perspective, the
 * inverse of the icon color: `Style.Dark` = dark background = light icons.
 */
export function syncNativeStatusBar(background: string): void {
  if (!native) return;
  const dark = isDarkHsl(background);
  void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(
    () => undefined,
  );
}
