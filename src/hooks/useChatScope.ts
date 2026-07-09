import { useContext } from "react";

import { ChatScopeContext } from "@/contexts/ChatScopeContext";

/** The chat scope (NIP-29 group / Concord channel) of the surrounding timeline, if any. */
export function useChatScope() {
  return useContext(ChatScopeContext);
}
