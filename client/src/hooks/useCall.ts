import { useContext } from "react";

import { CallContext } from "@/contexts/CallContext";

/** Access the app-level voice call state (active room + join/leave). */
export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error("useCall must be used within a CallProvider");
  }
  return ctx;
}
