import CArmadaSQLite
import Foundation

/// SQLite tells the difference between "this pointer outlives the call" and
/// "copy it" by a sentinel destructor, which C spells as a cast of -1.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// The `ArmadaSqlDriver` Armada actually runs on iOS: the VENDORED SQLite in
/// `CArmadaSQLite`, not the platform's.
///
/// Apple's `libsqlite3.dylib` is whatever the OS image shipped, and
/// `ArmadaDbSchema` needs 3.43 for FTS5 `contentless_delete` plus JSON1 —
/// which the deployment target (iOS 15) predates by two releases. Borrowing
/// the platform engine would make the schema's availability a function of the
/// device's iOS version; bundling makes it a constant, and the same source
/// compiles for Linux, which is how the conformance suite runs the real engine
/// as an ordinary `swift test`.
///
/// Every call is serialized on this object. The store's transactions are plain
/// `BEGIN IMMEDIATE` statements, so two callers interleaving statements would
/// splice their work into each other's transaction — `SqliteArmadaDb`'s
/// transaction lock covers that, and this lock is the finer one underneath it,
/// covering the single connection (a `sqlite3_stmt` is not safe to bind or step
/// from two threads at once, whatever the connection's threading mode).
public final class SqliteDriver: ArmadaSqlDriver {

    private var db: OpaquePointer?

    /// Prepared statements by SQL text. The store reuses statement shapes
    /// deliberately (whitespace is collapsed before every call, and value lists
    /// are batched to fixed sizes), so this turns a scan's per-page round trip
    /// into a bind + step with no re-parse. Bounded, evicting least-recently
    /// used, because a filter with an odd-length `IN (…)` mints a new shape.
    private var statements: [String: OpaquePointer] = [:]
    private var recency: [String] = []

    /// Reentrant because a row-mapping closure runs while the lock is held.
    private let lock = NSRecursiveLock()
    private var closed = false

    private static let statementCacheSize = 64

    /// - Parameters:
    ///   - path: the database file, or `":memory:"`.
    ///   - wal: whether to put the file in WAL mode. Skipped automatically for
    ///     in-memory databases, which have no journal to switch.
    public init(path: String, wal: Bool = true) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
            | SQLITE_OPEN_URI
        let status = sqlite3_open_v2(path, &handle, flags, nil)
        guard status == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) }
                ?? "unable to open \(path)"
            if let handle { sqlite3_close_v2(handle) }
            throw ArmadaDbError.sqlite(code: status, message: message, sql: "open \(path)")
        }
        db = handle
        sqlite3_extended_result_codes(handle, 1)

        // Covers the moment a checkpoint needs the file to itself — and, once
        // the notification extension exists, the moment the other process holds
        // the write lock.
        sqlite3_busy_timeout(handle, 5000)

        if wal && !Self.isInMemory(path) {
            // WAL keeps a reader (a bridge query) from blocking the writer on a
            // database both touch continuously. A filesystem that refuses WAL
            // keeps the rollback journal and still works, so this is advisory.
            try? exec("PRAGMA journal_mode = WAL")
            try? exec("PRAGMA synchronous = NORMAL")
        }
    }

    private static func isInMemory(_ path: String) -> Bool {
        path == ":memory:" || path.hasPrefix("file::memory:") || path.contains("mode=memory")
    }

    public func run(_ sql: String, _ params: [SqlValue]) throws {
        lock.lock()
        defer { lock.unlock() }

        let statement = try prepare(sql)
        defer { sqlite3_reset(statement) }
        try bind(statement, params, sql)

        let status = sqlite3_step(statement)
        guard status == SQLITE_DONE || status == SQLITE_ROW else {
            throw error(status, sql)
        }
    }

    public func query<T>(
        _ sql: String,
        _ params: [SqlValue],
        _ read: (SqlRow) throws -> T
    ) throws -> [T] {
        lock.lock()
        defer { lock.unlock() }

        let statement = try prepare(sql)
        defer { sqlite3_reset(statement) }
        try bind(statement, params, sql)

        var rows: [T] = []
        let row = StatementRow(statement: statement)
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_ROW {
                rows.append(try read(row))
            } else if status == SQLITE_DONE {
                return rows
            } else {
                throw error(status, sql)
            }
        }
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }

        if closed { return }
        closed = true
        for statement in statements.values { sqlite3_finalize(statement) }
        statements.removeAll()
        recency.removeAll()
        if let db { sqlite3_close_v2(db) }
        db = nil
    }

    deinit {
        close()
    }

    // MARK: - internals

    private func prepare(_ sql: String) throws -> OpaquePointer {
        guard !closed, let db else { throw ArmadaDbError.closed }

        if let cached = statements[sql] {
            // A statement reused across calls still holds the previous call's
            // bindings; clearing is what keeps a shorter parameter list from
            // inheriting the longer one's tail.
            sqlite3_reset(cached)
            sqlite3_clear_bindings(cached)
            touch(sql)
            return cached
        }

        var statement: OpaquePointer?
        let status = sqlite3_prepare_v3(
            db, sql, -1, UInt32(SQLITE_PREPARE_PERSISTENT), &statement, nil
        )
        guard status == SQLITE_OK, let statement else {
            if let statement { sqlite3_finalize(statement) }
            throw error(status, sql)
        }

        statements[sql] = statement
        recency.append(sql)
        evictIfNeeded()
        return statement
    }

    private func touch(_ sql: String) {
        if let index = recency.lastIndex(of: sql) {
            recency.remove(at: index)
        }
        recency.append(sql)
    }

    private func evictIfNeeded() {
        while statements.count > Self.statementCacheSize, let oldest = recency.first {
            recency.removeFirst()
            if let evicted = statements.removeValue(forKey: oldest) {
                sqlite3_finalize(evicted)
            }
        }
    }

    private func bind(_ statement: OpaquePointer, _ params: [SqlValue], _ sql: String) throws {
        for (index, value) in params.enumerated() {
            let slot = Int32(index + 1)
            let status: Int32
            switch value {
            case .null:
                status = sqlite3_bind_null(statement, slot)
            case let .text(text):
                // Bound with an explicit BYTE COUNT, never `-1`. A length of -1
                // means "up to the first NUL", which would silently truncate
                // every user-controlled string that contains one — a tag value,
                // a KV key, a rumor's content — and store something the caller
                // never asked to store.
                let bytes = Array(text.utf8)
                if bytes.isEmpty {
                    // A null pointer binds SQL NULL rather than an empty string,
                    // so the empty case needs a real (if unread) pointer.
                    status = sqlite3_bind_text(statement, slot, "", 0, SQLITE_TRANSIENT)
                } else {
                    status = bytes.withUnsafeBytes { buffer in
                        sqlite3_bind_text(
                            statement,
                            slot,
                            buffer.baseAddress!.assumingMemoryBound(to: CChar.self),
                            Int32(buffer.count),
                            SQLITE_TRANSIENT
                        )
                    }
                }
            case let .int(number):
                status = sqlite3_bind_int64(statement, slot, number)
            case let .double(number):
                status = sqlite3_bind_double(statement, slot, number)
            case let .blob(bytes):
                status = bytes.withUnsafeBytes { buffer in
                    sqlite3_bind_blob(
                        statement, slot, buffer.baseAddress, Int32(buffer.count), SQLITE_TRANSIENT
                    )
                }
            }
            guard status == SQLITE_OK else { throw error(status, sql) }
        }
    }

    /// A statement run for its side effect, before the cache is useful.
    private func exec(_ sql: String) throws {
        guard let db else { throw ArmadaDbError.closed }
        var statement: OpaquePointer?
        let status = sqlite3_prepare_v2(db, sql, -1, &statement, nil)
        guard status == SQLITE_OK, let statement else {
            if let statement { sqlite3_finalize(statement) }
            throw error(status, sql)
        }
        defer { sqlite3_finalize(statement) }
        let stepped = sqlite3_step(statement)
        guard stepped == SQLITE_DONE || stepped == SQLITE_ROW else {
            throw error(stepped, sql)
        }
    }

    private func error(_ code: Int32, _ sql: String) -> ArmadaDbError {
        let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
        return .sqlite(code: code, message: message, sql: sql)
    }

    private struct StatementRow: SqlRow {
        let statement: OpaquePointer

        func isNull(_ index: Int) -> Bool {
            sqlite3_column_type(statement, Int32(index)) == SQLITE_NULL
        }

        func text(_ index: Int) -> String {
            let column = Int32(index)
            guard let bytes = sqlite3_column_text(statement, column) else { return "" }
            let count = Int(sqlite3_column_bytes(statement, column))
            guard count > 0 else { return "" }
            return String(decoding: UnsafeBufferPointer(start: bytes, count: count), as: UTF8.self)
        }

        func int(_ index: Int) -> Int64 {
            sqlite3_column_int64(statement, Int32(index))
        }
    }
}
