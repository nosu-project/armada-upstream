package buzz.armada.app.db

/** SQL fragment builders shared by the planner. A port of `src/lib/db/sql.ts`. */
internal object Sql {

    /** `?, ?, ?` — a placeholder list of the given length. */
    fun qs(length: Int): String = (0 until length).joinToString(", ") { "?" }

    /**
     * A membership test on a column, as `= ?` for a single value and `IN (…)`
     * for several.
     *
     * The distinction matters: an equality on an index column keeps the scan
     * ordered by the columns after it, so `ORDER BY created_at DESC` comes free,
     * whereas `IN` makes SQLite loop over the values and sort the union. Writing
     * a one-element list as `IN (?)` measurably slows tag scans.
     */
    fun memberOf(column: String, values: Collection<*>): String =
        if (values.size == 1) "$column = ?" else "$column IN (${qs(values.size)})"

    /** Join conditions into a `WHERE` clause, or nothing if there are none. */
    fun where(conditions: List<String>): String =
        if (conditions.isEmpty()) "" else " WHERE ${conditions.joinToString(" AND ")}"

    /**
     * Split values into chunks that fit within a statement's parameter budget.
     * An empty list yields NO chunks, not one empty chunk — a caller that
     * emitted `IN ()` for it would be building invalid SQL.
     */
    fun <T> batch(values: List<T>, size: Int): List<List<T>> = values.chunked(size)
}

/** Collapse a statement's whitespace, so its cached prepared form is reused. */
internal fun String.collapseWhitespace(): String = trim().replace(WHITESPACE, " ")

private val WHITESPACE = Regex("\\s+")
