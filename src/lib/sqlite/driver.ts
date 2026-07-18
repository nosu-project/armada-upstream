/**
 * The minimal SQL transport the event store runs on. Two implementations:
 * a Web Worker running SQLite-WASM over OPFS (web / Electron), and the
 * Capacitor bridge into the native Android database that the notification
 * service shares (nativeDriver.ts). Keeping the surface this small means the
 * NIP-01 filter engine lives ONCE, in TypeScript (filterToSql.ts /
 * SqliteEventStore.ts), and the transports stay dumb.
 */
export type SqlParam = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlParam[];
}

export interface SqlDriver {
  /** Execute the statements atomically, in order, in one transaction. */
  run(statements: SqlStatement[]): Promise<void>;
  /** Run a single SELECT; rows come back as positional value arrays. */
  query(sql: string, params?: SqlParam[]): Promise<SqlParam[][]>;
  /** Release the connection (worker, plugin handle). */
  close(): Promise<void>;
}
