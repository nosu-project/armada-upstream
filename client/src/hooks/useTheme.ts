import { useCallback } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { syncNativeStatusBar } from "@/lib/statusBar";
import {
  buildThemeCssFromCore,
  builtinThemes,
  resolveTheme,
  resolveThemeColors,
  type ThemeConfig,
} from "@/themes";

import type { Theme } from "@/contexts/AppContext";

/**
 * Theme read/write API. Mirrors Ditto's useTheme: switching synchronously
 * injects the new CSS variables before React re-renders to avoid flicker and
 * persists to AppConfig. The change is pushed to the user's encrypted NIP-78
 * settings centrally by NostrSync (which watches all synced AppConfig fields),
 * so this hook no longer syncs individual fields itself.
 */
export function useTheme() {
  const { config, updateConfig } = useAppContext();

  /** Synchronously paint a set of core colors into <style id="theme-vars">. */
  const paint = useCallback((mode: Theme, custom?: ThemeConfig) => {
    const resolved = resolveTheme(mode);
    const colors =
      resolved === "custom"
        ? (custom?.colors ?? config.customTheme?.colors ?? builtinThemes.dark)
        : resolveThemeColors(resolved, config.themes);

    // Suppress transitions for the swap so colors change instantly.
    const noTransition = document.createElement("style");
    noTransition.textContent = "*{transition:none !important}";
    document.head.appendChild(noTransition);

    let el = document.getElementById("theme-vars") as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "theme-vars";
      document.head.appendChild(el);
    }
    el.textContent = buildThemeCssFromCore(colors);

    // Retint the native status/navigation bars to contrast with the new theme
    // background (no-op on web).
    syncNativeStatusBar(colors.background);

    requestAnimationFrame(() => {
      noTransition.remove();
    });
  }, [config.customTheme, config.themes]);

  /** Switch between light / dark / system / custom. */
  const setTheme = useCallback((theme: Theme) => {
    paint(theme);
    updateConfig((current) => ({ ...current, theme }));
  }, [paint, updateConfig]);

  /** Apply a custom theme (named preset or builder output). */
  const applyCustomTheme = useCallback((themeConfig: ThemeConfig) => {
    paint("custom", themeConfig);
    updateConfig((current) => ({ ...current, theme: "custom", customTheme: themeConfig }));
  }, [paint, updateConfig]);

  return {
    theme: config.theme,
    customTheme: config.customTheme,
    setTheme,
    applyCustomTheme,
  };
}
