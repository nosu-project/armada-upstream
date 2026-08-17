import { useContext } from "react";

import { VoiceActivityContext } from "@/contexts/VoiceActivityContext";

/**
 * The active call's live speaker / muted / raised-hand / roster sets.
 *
 * Separate from {@link useCall} because these are the per-frame values: a
 * component that reads them re-renders as fast as the room reports, so reach
 * for this only where live voice activity is actually rendered (roster rows,
 * the call stage). Anything that needs the call itself, or wants to START or
 * REPORT one, should use `useCall()` and will not re-render on this traffic.
 */
export function useVoiceActivity() {
  const ctx = useContext(VoiceActivityContext);
  if (!ctx) {
    throw new Error("useVoiceActivity must be used within a CallProvider");
  }
  return ctx;
}
