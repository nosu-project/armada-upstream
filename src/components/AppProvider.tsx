import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";

import { AppConfigSchema } from "@/lib/schemas";
import { AppContext, defaultConfig, type AppConfig } from "@/contexts/AppContext";
import {
  accountScopedKey,
  adoptLegacyConfig,
  getActivePubkey,
  subscribeActivePubkey,
} from "@/lib/activeAccount";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { hslStringToHex, isDarkTheme } from "@/lib/colorUtils";
import { syncNativeStatusBar } from "@/lib/statusBar";
import {
  buildThemeCssFromCore,
  builtinThemes,
  resolveTheme,
  resolveThemeColors,
  type CoreThemeColors,
} from "@/themes";

/** Validate each key individually so one corrupt field doesn't reset everything. */
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

  // Migration: `useOwnDmRelays` split into `useAppDmRelays` + `useOwnDmRelays`;
  // preserve the old XOR ("own" meant own relays ONLY).
  if (!("useAppDmRelays" in source)) {
    const storedOwn = source.useOwnDmRelays === true;
    const storedDm = Array.isArray(source.dmRelays) ? source.dmRelays : [];
    const ownOnly = storedOwn && storedDm.length > 0;
    result.useAppDmRelays = !ownOnly;
    result.useOwnDmRelays = ownOnly;
  }

  return result as unknown as AppConfig;
}

function activeColors(config: AppConfig): CoreThemeColors {
  const resolved = resolveTheme(config.theme);
  if (resolved === "custom") {
    return config.customTheme?.colors ?? builtinThemes.dark;
  }
  return resolveThemeColors(resolved);
}

/**
 * Inject theme CSS variables and the `<html>` class before paint; re-runs on OS
 * scheme changes when theme is "system".
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

      // "custom" themes pick the dark variant from background luminance.
      const root = document.documentElement;
      const isDark = resolved === "dark"
        || (resolved === "custom" && isDarkTheme(colors.background));
      root.classList.toggle("dark", isDark);
      root.classList.toggle("custom", resolved === "custom");

      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", hslStringToHex(colors.background));

      // No-op on web.
      syncNativeStatusBar(colors.background);
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
  // The config blob is PER ACCOUNT (it holds DM peer lists), and the key must be
  // picked on first render above `NostrLoginProvider`, so read the synchronous
  // marker (see `lib/activeAccount.ts`).
  const pubkey = useSyncExternalStore(subscribeActivePubkey, getActivePubkey);

  // Must run before the scoped key is read: hands the pre-scoping blob to the
  // first active account only.
  const scopedKey = useMemo(() => {
    if (pubkey) adoptLegacyConfig(storageKey, pubkey);
    return accountScopedKey(storageKey, pubkey);
  }, [storageKey, pubkey]);

  const [config, setConfig] = useLocalStorage<AppConfig>(scopedKey, defaultConfig, {
    serialize: JSON.stringify,
    deserialize: deserializeConfig,
  });

  useApplyTheme(config);

  // public/theme.js handles the very first paint.
  useEffect(() => {
    document.documentElement.dataset.themeReady = "true";
  }, []);

  // Memoized: dozens of files (and NostrProvider) read this context.
  // `setConfig` is reference-stable.
  const value = useMemo(
    () => ({ config, updateConfig: setConfig }),
    [config, setConfig],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
