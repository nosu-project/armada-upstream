/**
 * Native status-bar icon style to contrast with the theme background
 * (Capacitor only; the app is edge-to-edge). Driven from `useTheme.paint()`.
 */

import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

const native = Capacitor.isNativePlatform();

/** Parse an `"H S% L%"` HSL string and decide if it reads as a dark color. */
function isDarkHsl(hsl: string): boolean {
  const parts = String(hsl).trim().replace(/%/g, "").split(/\s+/).map(Number);
  const l = parts[2];
  if (Number.isNaN(l)) return true;
  return l < 45;
}

/**
 * `background` is the theme's `--background` as `"H S% L%"`. Capacitor's
 * `Style` names the BACKGROUND: `Style.Dark` = light icons.
 */
export function syncNativeStatusBar(background: string): void {
  if (!native) return;
  const dark = isDarkHsl(background);
  void StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(
    () => undefined,
  );
}
