import { useContext } from "react";

import { VoiceActivityContext } from "@/contexts/VoiceActivityContext";

/**
 * The active call's per-frame speaker / muted / raised-hand / roster sets.
 * Re-renders as fast as the room reports; use `useCall()` for anything else.
 */
export function useVoiceActivity() {
  const ctx = useContext(VoiceActivityContext);
  if (!ctx) {
    throw new Error("useVoiceActivity must be used within a CallProvider");
  }
  return ctx;
}
