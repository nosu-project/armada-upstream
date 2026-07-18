import { ArmadaNotification } from "@/lib/nativeNotifications";

import type { SqlDriver } from "./driver";

/**
 * SqlDriver over the Capacitor bridge into the native Android database
 * (SharedEventDb.java) — the SAME file NotificationRelayService writes, so
 * events the service received while the webview was down (and the kind-0
 * profiles either side fetched) are simply *there*, with no second store and
 * no re-fetch. The native side owns the schema; this driver never runs DDL.
 */
export function nativeSqlDriver(): SqlDriver {
  return {
    async run(statements) {
      await ArmadaNotification.dbRun({
        statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
      });
    },
    async query(sql, params) {
      const { rows } = await ArmadaNotification.dbQuery({ sql, params: params ?? [] });
      return rows;
    },
    async close() {
      // The native connection outlives the webview (the service uses it).
    },
  };
}

/**
 * Probe whether the native database bridge is actually there (it is on any
 * Android binary shipping this JS, but a failed native init degrades
 * gracefully to the WASM/IndexedDB path instead of a dead store).
 */
export async function probeNativeSqlDriver(): Promise<SqlDriver | null> {
  try {
    await ArmadaNotification.dbQuery({ sql: "SELECT 1", params: [] });
    return nativeSqlDriver();
  } catch {
    return null;
  }
}
