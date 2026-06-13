import { useEffect, useLayoutEffect } from "react";

import { AppConfigSchema } from "@/lib/schemas";
import { AppContext, defaultConfig, type AppConfig } from "@/contexts/AppContext";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { hslStringToHex, isDarkTheme } from "@/lib/colorUtils";
import {
  buildThemeCssFromCore,
  builtinThemes,
  resolveTheme,
  resolveThemeColors,
  type CoreThemeColors,
} from "@/themes";

/**
 * Per-field deserialization: each top-level key is validated individually
 * against the schema, so one corrupt/missing field doesn't reset everything.
 */
function deserializeConfig(raw: string): AppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultConfig;
  }
  if (!parsed || typeof parsed !== "object") return defaultConfig;

  const source = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = { ...defaultConfig };

  for (const key of Object.keys(AppConfigSchema.shape) as Array<keyof typeof AppConfigSchema.shape>) {
    if (!(key in source)) continue;
    const fieldSchema = AppConfigSchema.shape[key];
    const outcome = fieldSchema.safeParse(source[key]);
    if (outcome.success && outcome.data !== undefined) {
      result[key] = outcome.data;
    }
  }

  return result as unknown as AppConfig;
}

/** Resolve the active theme's core colors from config. */
function activeColors(config: AppConfig): CoreThemeColors {
  const resolved = resolveTheme(config.theme);
  if (resolved === "custom") {
    return config.customTheme?.colors ?? builtinThemes.dark;
  }
  return resolveThemeColors(resolved, config.themes);
}

/**
 * Inject the derived theme CSS variables into a `<style id="theme-vars">`
 * element and set the `<html>` class. Runs before paint to avoid flicker and
 * re-runs on OS scheme changes when theme is "system".
 */
function useApplyTheme(config: AppConfig) {
  useLayoutEffect(() => {
    const apply = () => {
      const resolved = resolveTheme(config.theme);
      const colors = activeColors(config);
      const css = buildThemeCssFromCore(colors);

      let el = document.getElementById("theme-vars") as HTMLStyleElement | null;
      if (!el) {
        el = document.createElement("style");
        el.id = "theme-vars";
        document.head.appendChild(el);
      }
      el.textContent = css;

      // `.dark` drives Tailwind's dark-variant styling; "custom" themes pick
      // the variant that matches their background luminance.
      const root = document.documentElement;
      const isDark = resolved === "dark"
        || (resolved === "custom" && isDarkTheme(colors.background));
      root.classList.toggle("dark", isDark);
      root.classList.toggle("custom", resolved === "custom");

      // Keep the browser chrome <meta theme-color> in sync.
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", hslStringToHex(colors.background));
    };

    apply();

    if (config.theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [config]);
}

interface AppProviderProps {
  storageKey: string;
  children: React.ReactNode;
}

export function AppProvider({ storageKey, children }: AppProviderProps) {
  const [config, setConfig] = useLocalStorage<AppConfig>(storageKey, defaultConfig, {
    serialize: JSON.stringify,
    deserialize: deserializeConfig,
  });

  useApplyTheme(config);

  // Ensure first-paint <html> class matches before React hydration completes
  // (the public/theme.js bootstrap handles the very first paint).
  useEffect(() => {
    document.documentElement.dataset.themeReady = "true";
  }, []);

  return (
    <AppContext.Provider value={{ config, updateConfig: setConfig }}>
      {children}
    </AppContext.Provider>
  );
}
