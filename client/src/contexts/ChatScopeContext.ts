import { createContext } from "react";

import type { AppScope } from "@/contexts/AppsContext";

/**
 * The chat scope (NIP-29 group or Concord channel) the surrounding timeline
 * belongs to. Provided by the chat pages so in-message affordances — notably a
 * `.xdc` attachment's "launch app" card — can open an app into the right
 * coordination plane without threading scope through every render prop.
 */
export const ChatScopeContext = createContext<AppScope | undefined>(undefined);
