import { createContext } from "react";

import type { AppScope } from "@/contexts/AppsContext";

/** The chat scope of the surrounding timeline, so e.g. `.xdc` cards launch into the right plane. */
export const ChatScopeContext = createContext<AppScope | undefined>(undefined);
