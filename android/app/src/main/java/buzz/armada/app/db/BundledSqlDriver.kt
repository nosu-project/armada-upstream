package buzz.armada.app.db

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver

/**
 * The [ArmadaSqlDriver] Armada actually runs on: androidx's BUNDLED SQLite, not
 * the platform's.
 *
 * `android.database.sqlite` is whatever the OS image shipped — SQLite 3.9 on
 * minSdk 24 — and [ArmadaDbSchema] needs 3.43 for FTS5 `contentless_delete`
 * plus JSON1 for the search trigger's `json_extract`. Borrowing the platform
 * engine would make the schema's availability a function of the device's
 * Android version; bundling makes it a constant (3.50.1, per ABI). The same
 * artifact resolves on the JVM, which is how the conformance suite runs the
 * real engine as an ordinary unit test.
 *
 * Every call is serialized on this object. The store's transactions are plain
 * `BEGIN IMMEDIATE` statements, so two callers interleaving statements would
 * splice their work into each other's transaction — [SqliteArmadaDb.transaction]
 * holds the write lock for that, and this lock is the finer one underneath it,
 * covering the single connection androidx hands out (a [SQLiteStatement] is not
 * thread-safe, and neither is stepping two of them at once).
 */
class BundledSqlDriver(path: String) : ArmadaSqlDriver {

    private val connection: SQLiteConnection = BundledSQLiteDriver().open(path)

    /**
     * Prepared statements by SQL text. The store reuses statement shapes
     * deliberately (whitespace is collapsed before every call, and value lists
     * are batched to fixed sizes), so this turns a scan's per-page round trip
     * into a bind + step with no re-parse. Bounded, evicting least-recently
     * used, because a filter with an odd-length `IN (…)` mints a new shape.
     */
    private val cache = object : LinkedHashMap<String, SQLiteStatement>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, SQLiteStatement>): Boolean {
            if (size <= STATEMENT_CACHE_SIZE) return false
            eldest.value.close()
            return true
        }
    }

    private var closed = false

    init {
        // WAL keeps a reader (a bridge query) from blocking the writer (the
        // service's ingest) on a database both touch continuously; the busy
        // timeout covers the moment a checkpoint needs the file to itself.
        exec("PRAGMA journal_mode = WAL")
        exec("PRAGMA busy_timeout = 5000")
        exec("PRAGMA synchronous = NORMAL")
    }

    override fun run(sql: String, params: List<Any?>) {
        synchronized(this) {
            val statement = prepare(sql)
            bind(statement, params)
            statement.step()
            statement.reset()
        }
    }

    override fun <T> query(sql: String, params: List<Any?>, read: (SqlRow) -> T): List<T> {
        synchronized(this) {
            val statement = prepare(sql)
            bind(statement, params)
            val rows = ArrayList<T>()
            val row = StatementRow(statement)
            while (statement.step()) rows.add(read(row))
            statement.reset()
            return rows
        }
    }

    override fun close() {
        synchronized(this) {
            if (closed) return
            closed = true
            for (statement in cache.values) runCatching { statement.close() }
            cache.clear()
            connection.close()
        }
    }

    private fun prepare(sql: String): SQLiteStatement {
        check(!closed) { "ArmadaDB: driver is closed" }
        val cached = cache[sql]
        if (cached != null) {
            // A statement reused across calls still holds the previous call's
            // bindings; clearing is what keeps a shorter parameter list from
            // inheriting the longer one's tail.
            cached.reset()
            cached.clearBindings()
            return cached
        }
        val statement = connection.prepare(sql)
        cache[sql] = statement
        return statement
    }

    private fun bind(statement: SQLiteStatement, params: List<Any?>) {
        for ((index, value) in params.withIndex()) {
            val slot = index + 1
            when (value) {
                null -> statement.bindNull(slot)
                is String -> statement.bindText(slot, value)
                is Int -> statement.bindLong(slot, value.toLong())
                is Long -> statement.bindLong(slot, value)
                is Double -> statement.bindDouble(slot, value)
                is Float -> statement.bindDouble(slot, value.toDouble())
                is ByteArray -> statement.bindBlob(slot, value)
                is Boolean -> statement.bindLong(slot, if (value) 1L else 0L)
                else -> statement.bindText(slot, value.toString())
            }
        }
    }

    /** A statement run for its side effect during construction, before the cache is useful. */
    private fun exec(sql: String) {
        connection.prepare(sql).use { statement ->
            statement.step()
        }
    }

    private class StatementRow(private val statement: SQLiteStatement) : SqlRow {
        override fun isNull(index: Int): Boolean = statement.isNull(index)
        override fun text(index: Int): String = statement.getText(index)
        override fun long(index: Int): Long = statement.getLong(index)
    }

    private companion object {
        const val STATEMENT_CACHE_SIZE = 64
    }
}
