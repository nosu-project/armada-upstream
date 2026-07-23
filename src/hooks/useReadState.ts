import { useContext } from "react";

import {
  ReadStateContext,
  channelReadKey,
  concord1ReadKey,
  concord2MentionReadKey,
  concord2ReadKey,
  concord2ThreadReadKey,
  dmReadKey,
} from "@/contexts/ReadStateContext";

export { channelReadKey, concord1ReadKey, concord2MentionReadKey, concord2ReadKey, concord2ThreadReadKey, dmReadKey };

/** Access per-conversation read-state (last-read timestamps). */
export function useReadState() {
  const ctx = useContext(ReadStateContext);
  if (!ctx) {
    throw new Error("useReadState must be used within a ReadStateProvider");
  }
  return ctx;
}
