import { createContext } from "react";

import { APP_RELAYS } from "@/lib/platform";

export type Theme = "light" | "dark" | "system";

/**
 * Application configuration, persisted to localStorage by AppProvider.
 *
 * Armada is an internal-infrastructure tool: the base server list is pinned
 * at build time (VITE_PLATFORM_RELAYS) and users may extend it with
 * additional internal relay URLs.
 */
export interface AppConfig {
  /** Display theme. */
  theme: Theme;
  /** Relay (server) URLs the user added on top of the pinned platform relays. */
  addedRelays: string[];
  /**
   * App relays for non-NIP-29 traffic (kind 0 profiles, kind 10009 lists,
   * etc.) — Ditto's "app relays" concept. Seeded from VITE_APP_RELAYS
   * (default: relay.ditto.pub + relay.dreamith.to); user-editable.
   * Group-scoped events never route here.
   */
  appRelays: string[];
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
};

export const AppContext = createContext<AppContextType | undefined>(undefined);
