import { createContext } from "react";

import type { ArmadaDB } from "@/lib/db/types";

/**
 * The app-wide {@link ArmadaDB}. Unlike the event-store context this carries
 * the database itself rather than a promise: adapters construct synchronously
 * and open their storage in the background, so every call already waits for
 * the connection internally.
 */
export const ArmadaDBContext = createContext<ArmadaDB | null>(null);
