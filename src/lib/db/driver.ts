/**
 * The minimum surface {@link SqliteArmadaDB} needs from a SQLite library —
 * statement text plus bound parameters, on ONE connection.
 *
 * Deliberately narrower than a "run this batch atomically" interface: the
 * query planner interleaves reads and writes inside a transaction — read the
 * coordinate, then supersede it — and issues `BEGIN IMMEDIATE` / `COMMIT` as
 * ordinary statements. A driver must therefore run statements in call order on
 * a single connection; it must NOT multiplex them across connections or
 * reorder them.
 *
 * Both methods may be sync or async, so this fits `node:sqlite`,
 * better-sqlite3, a SQLite-WASM worker behind postMessage, and the Capacitor
 * bridge alike. Drivers are encouraged to cache prepared statements keyed by
 * the SQL string, which is why the store reuses statement shapes.
 */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** A row, as a plain column-name → value object. */
export type SqlRow = Record<string, SqlValue>;

export interface ArmadaSqlDriver {
  /** Execute a statement that returns no rows. */
  run(sql: string, params?: SqlValue[]): void | Promise<void>;
  /** Execute a statement and return every row it produces. */
  all(sql: string, params?: SqlValue[]): SqlRow[] | Promise<SqlRow[]>;
  /** Release the underlying connection, if the driver has one to release. */
  close?(): void | Promise<void>;
}
