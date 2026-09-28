/**
 * The minimum SQLite surface {@link SqliteArmadaDB} needs. Statements MUST run
 * in call order on ONE connection: the planner interleaves reads and writes in
 * transactions and issues `BEGIN IMMEDIATE`/`COMMIT` as ordinary statements.
 * Methods may be sync or async. Drivers should cache prepared statements by SQL.
 */
export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlRow = Record<string, SqlValue>;

export interface ArmadaSqlDriver {
  run(sql: string, params?: SqlValue[]): void | Promise<void>;
  all(sql: string, params?: SqlValue[]): SqlRow[] | Promise<SqlRow[]>;
  /** Release the underlying connection, if the driver has one to release. */
  close?(): void | Promise<void>;
}
