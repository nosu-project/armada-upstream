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
 * The database itself is returned, not a promise — every method waits for its
 * own storage internally. `tenant(id)` returns the same store for the same id,
 * so it's safe to call inline in a render or an effect.
 */
export function useDB(): ArmadaDB {
  const db = useContext(ArmadaDBContext);
  if (!db) {
    throw new Error("useDB must be used within an ArmadaDBProvider");
  }
  return db;
}
