import { useContext } from "react";

import { AppContext, type AppContextType } from "@/contexts/AppContext";

export function useAppContext(): AppContextType {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useAppContext must be used within an AppProvider");
  }
  return context;
}
