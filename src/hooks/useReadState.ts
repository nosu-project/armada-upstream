import { useContext } from "react";

import { ReadStateContext, channelReadKey, concord1ReadKey, concord2ReadKey, dmReadKey } from "@/contexts/ReadStateContext";

export { channelReadKey, concord1ReadKey, concord2ReadKey, dmReadKey };

/** Access per-conversation read-state (last-read timestamps). */
export function useReadState() {
  const ctx = useContext(ReadStateContext);
  if (!ctx) {
    throw new Error("useReadState must be used within a ReadStateProvider");
  }
  return ctx;
}
