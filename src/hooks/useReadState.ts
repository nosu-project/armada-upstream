import { useContext } from "react";

import {
  ReadStateContext,
  channelReadKey,
  concordInviteReadKey,
  concordMentionReadKey,
  concordReadKey,
  concordThreadReadKey,
  dmReadKey,
} from "@/contexts/ReadStateContext";

export {
  channelReadKey,
  concordInviteReadKey,
  concordMentionReadKey,
  concordReadKey,
  concordThreadReadKey,
  dmReadKey,
};

/** Access per-conversation read-state (last-read timestamps). */
export function useReadState() {
  const ctx = useContext(ReadStateContext);
  if (!ctx) {
    throw new Error("useReadState must be used within a ReadStateProvider");
  }
  return ctx;
}
