import { createContext } from "react";

import { APP_RELAYS, SEARCH_RELAYS } from "@/lib/platform";

import type { ThemeConfig, ThemesConfig } from "@/themes";

export type Theme = "light" | "dark" | "system" | "custom";

/**
 * Application configuration, persisted to localStorage by AppProvider.
 *
 * Armada is an internal-infrastructure tool: the base server list is pinned
 * at build time (VITE_PLATFORM_RELAYS) and users may extend it with
 * additional internal relay URLs.
 */
export interface AppConfig {
  /** Display theme mode. */
  theme: Theme;
  /**
   * Custom theme colors, used when `theme === "custom"` (set by named
   * presets or the in-app theme builder).
   */
  customTheme?: ThemeConfig;
  /**
   * Optional per-mode overrides for the builtin light/dark themes. When set,
   * these replace the builtin core colors for the respective mode.
   */
  themes?: ThemesConfig;
  /** Relay (server) URLs the user added on top of the pinned platform relays. */
  addedRelays: string[];
  /**
   * App relays for non-NIP-29 traffic (kind 0 profiles, kind 10009 lists,
   * etc.) — Ditto's "app relays" concept. Seeded from VITE_APP_RELAYS
   * (default: relay.ditto.pub + relay.dreamith.to); user-editable.
   * Group-scoped events never route here.
   */
  appRelays: string[];
  /**
   * Search relays for NIP-50 queries (`search` filters: profile/mention
   * autocomplete, etc.). Ditto hardcodes these (DITTO_RELAYS); here they are
   * user-editable. Seeded from VITE_SEARCH_RELAYS. When empty, search falls
   * back to the app relays.
   */
  searchRelays: string[];
}

export interface AppContextType {
  config: AppConfig;
  /** Merge a partial config and persist. */
  updateConfig: (updater: (current: AppConfig) => AppConfig) => void;
}

export const defaultConfig: AppConfig = {
  theme: "dark",
  addedRelays: [],
  appRelays: [...APP_RELAYS],
  searchRelays: [...SEARCH_RELAYS],
};

export const AppContext = createContext<AppContextType | undefined>(undefined);
