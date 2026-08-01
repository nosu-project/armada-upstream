package buzz.armada.app.db

/**
 * The minimum surface [SqliteArmadaDb] needs from a SQLite library — statement
 * text plus bound parameters, on ONE connection. A port of `src/lib/db/driver.ts`.
 *
 * Deliberately narrower than a "run this batch atomically" interface: the query
 * planner interleaves reads and writes inside a transaction — read the
 * coordinate, then supersede it — and issues `BEGIN IMMEDIATE` / `COMMIT` as
 * ordinary statements. A driver must therefore run statements in call order on
 * a single connection; it must NOT multiplex them across connections or
 * reorder them.
 *
 * Rows are read positionally rather than by column name. Every statement in the
 * store is written here, so the column order is always known, and skipping the
 * name lookup (and the value-type sniffing a generic row map would need) keeps
 * the hot scan path to one virtual call per column.
 */
interface ArmadaSqlDriver {
    /** Execute a statement that returns no rows. */
    fun run(sql: String, params: List<Any?> = emptyList())

    /** Execute a statement, mapping each row it produces with [read]. */
    fun <T> query(sql: String, params: List<Any?> = emptyList(), read: (SqlRow) -> T): List<T>

    /** Release the underlying connection. */
    fun close()
}

/** One row of a result set, addressed by zero-based column index. */
interface SqlRow {
    fun isNull(index: Int): Boolean
    fun text(index: Int): String
    fun long(index: Int): Long

    /** The column as a [Long], or null where SQL returned NULL. */
    fun longOrNull(index: Int): Long? = if (isNull(index)) null else long(index)
}
