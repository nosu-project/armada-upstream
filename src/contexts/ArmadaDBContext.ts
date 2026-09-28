import { createContext } from "react";

import type { ArmadaDB } from "@/lib/db/types";

/** The app-wide {@link ArmadaDB} itself (not a promise): calls wait for the connection internally. */
export const ArmadaDBContext = createContext<ArmadaDB | null>(null);
