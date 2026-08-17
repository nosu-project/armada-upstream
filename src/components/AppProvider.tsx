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

  // Migration: the DM-relay model split the single `useOwnDmRelays` boolean into
  // two independent toggles (`useAppDmRelays` + `useOwnDmRelays`). For a config
  // predating `useAppDmRelays`, preserve the old XOR behavior: "use own" meant
  // "own relays ONLY" (app off); anything else meant "app defaults".
  if (!("useAppDmRelays" in source)) {
    const storedOwn = source.useOwnDmRelays === true;
    const storedDm = Array.isArray(source.dmRelays) ? source.dmRelays : [];
    const ownOnly = storedOwn && storedDm.length > 0;
    result.useAppDmRelays = !ownOnly;
    result.useOwnDmRelays = ownOnly;
  }

  return result as unknown as AppConfig;
}

/** Resolve the active theme's core colors from config. */
function activeColors(config: AppConfig): CoreThemeColors {
  const resolved = resolveTheme(config.theme);
  if (resolved === "custom") {
    return config.customTheme?.colors ?? builtinThemes.dark;
  }
  return resolveThemeColors(resolved);
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

      // Keep the native status/navigation bar style in sync (no-op on web).
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
  // The config blob is PER ACCOUNT. It carries the DM peer lists
  // (`startedDms`, `acceptedDms`, `pinnedDms`, …) and the rail's arrangement,
  // so one shared blob meant every account on the device showed every other
  // account's conversations — and, because `docToConfigPatch` only copies keys
  // the incoming NIP-78 document actually has, each account then republished
  // the others' peers as its own.
  //
  // The pubkey can't come from the login context: `AppProvider` is mounted
  // ABOVE `NostrLoginProvider` (whose storage is an async keychain read on
  // native), and this hook has to pick a key on its first render. It reads the
  // synchronous marker instead — see `lib/activeAccount.ts`.
  const pubkey = useSyncExternalStore(subscribeActivePubkey, getActivePubkey);

  // `adoptLegacyConfig` is idempotent and synchronous, and has to run before
  // the scoped key is read: on upgrade the one pre-scoping blob is handed to
  // whichever account is active first, and to that account only.
  const scopedKey = useMemo(() => {
    if (pubkey) adoptLegacyConfig(storageKey, pubkey);
    return accountScopedKey(storageKey, pubkey);
  }, [storageKey, pubkey]);

  const [config, setConfig] = useLocalStorage<AppConfig>(scopedKey, defaultConfig, {
    serialize: JSON.stringify,
    deserialize: deserializeConfig,
  });

  useApplyTheme(config);

  // Ensure first-paint <html> class matches before React hydration completes
  // (the public/theme.js bootstrap handles the very first paint).
  useEffect(() => {
    document.documentElement.dataset.themeReady = "true";
  }, []);

  // Memoized because this context is read by 67 files, and an object literal
  // here re-renders every one of them on any AppProvider render — including
  // renders where `config` did not move at all. `setConfig` is reference-stable
  // (see `useLocalStorage`), so this changes only when the config does.
  //
  // It matters beyond this subtree: `NostrProvider` consumes this context, so
  // an invalidation here re-rendered it too, and its own value then reached the
  // ~96 files that call `useNostr()`.
  const value = useMemo(
    () => ({ config, updateConfig: setConfig }),
    [config, setConfig],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
