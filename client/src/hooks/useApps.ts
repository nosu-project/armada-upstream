import { useContext } from "react";

import { AppsContext } from "@/contexts/AppsContext";

/** Access the app-level in-chat apps state (active app + launch/close). */
export function useApps() {
  const ctx = useContext(AppsContext);
  if (!ctx) {
    throw new Error("useApps must be used within an AppsProvider");
  }
  return ctx;
}
