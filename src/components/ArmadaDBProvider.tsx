import { useMemo } from "react";

import { ArmadaDBContext } from "@/contexts/ArmadaDBContext";
import { getArmadaDB } from "@/lib/db/armadaDB";

import type { ReactNode } from "react";
import type { ArmadaDB } from "@/lib/db/types";

interface ArmadaDBProviderProps {
  children: ReactNode;
  /** Override the app-wide database. For tests and stories. */
  db?: ArmadaDB;
}

/** Provides the singleton {@link ArmadaDB} (`getArmadaDB`); read with `useDB()`. */
export function ArmadaDBProvider({ children, db }: ArmadaDBProviderProps) {
  const value = useMemo(() => db ?? getArmadaDB(), [db]);

  return <ArmadaDBContext.Provider value={value}>{children}</ArmadaDBContext.Provider>;
}

export default ArmadaDBProvider;
