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
 * Mirrors Ditto's useTheme: injects CSS variables synchronously to avoid flicker and persists
 * to AppConfig; NostrSync publishes it to NIP-78.
 */
export function useTheme() {
  const { config, updateConfig } = useAppContext();

  /** Synchronously paint core colors into <style id="theme-vars">. */
  const paint = useCallback((mode: Theme, custom?: ThemeConfig) => {
    const resolved = resolveTheme(mode);
    const colors =
      resolved === "custom"
        ? (custom?.colors ?? config.customTheme?.colors ?? builtinThemes.dark)
        : resolveThemeColors(resolved);

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

    // Retint native status/navigation bars (no-op on web).
    syncNativeStatusBar(colors.background);

    requestAnimationFrame(() => {
      noTransition.remove();
    });
  }, [config.customTheme]);

  const setTheme = useCallback((theme: Theme) => {
    paint(theme);
    updateConfig((current) => ({ ...current, theme }));
  }, [paint, updateConfig]);

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
