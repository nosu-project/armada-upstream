import { createContext } from "react";

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
}

export interface AppContextType {
  config: AppConfig;
  /** Merge a partial config and persist. */
  updateConfig: (updater: (current: AppConfig) => AppConfig) => void;
}

export const defaultConfig: AppConfig = {
  theme: "dark",
  addedRelays: [],
};

export const AppContext = createContext<AppContextType | undefined>(undefined);
