import { useContext } from "react";

import { ArmadaDBContext } from "@/contexts/ArmadaDBContext";

import type { ArmadaDB } from "@/lib/db/types";

/**
 * Access the app-wide {@link ArmadaDB}.
 *
 * ```ts
 * const db = useDB();
 * const events = await db.tenant(`c2:${concordId}`).query([{ "#channel": [channelId] }]);
 * const cursor = await db.kv.get<number>(`cursor:${concordId}`);
 * ```
 *
 * Returns the database itself (methods await storage); `tenant(id)` is stable per id.
 */
export function useDB(): ArmadaDB {
  const db = useContext(ArmadaDBContext);
  if (!db) {
    throw new Error("useDB must be used within an ArmadaDBProvider");
  }
  return db;
}
