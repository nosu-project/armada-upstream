import { useEffect } from "react";
import { z } from "zod";

import { AppContext, defaultConfig, type AppConfig } from "@/contexts/AppContext";
import { useLocalStorage } from "@/hooks/useLocalStorage";

const AppConfigSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).catch("dark"),
  addedRelays: z.array(z.string()).catch([]),
});

function deserializeConfig(raw: string): AppConfig {
  try {
    return AppConfigSchema.parse(JSON.parse(raw));
  } catch {
    return defaultConfig;
  }
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

  // Apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark = config.theme === "dark" ||
        (config.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
    };
    apply();
    if (config.theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [config.theme]);

  return (
    <AppContext.Provider value={{ config, updateConfig: setConfig }}>
      {children}
    </AppContext.Provider>
  );
}
