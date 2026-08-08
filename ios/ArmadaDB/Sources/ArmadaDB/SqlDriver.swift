/// The minimum surface `SqliteArmadaDb` needs from a SQLite library —
/// statement text plus bound parameters, on ONE connection. A port of
/// `src/lib/db/driver.ts`, by way of `ArmadaSqlDriver.kt`.
///
/// Deliberately narrower than a "run this batch atomically" interface: the
/// query planner interleaves reads and writes inside a transaction — read the
/// coordinate, then supersede it — and issues `BEGIN IMMEDIATE` / `COMMIT` as
/// ordinary statements. A driver must therefore run statements in call order on
/// a single connection; it must NOT multiplex them across connections or
/// reorder them.
///
/// Rows are read positionally rather than by column name. Every statement in
/// the store is written here, so the column order is always known, and skipping
/// the name lookup (and the value-type sniffing a generic row map would need)
/// keeps the hot scan path to one call per column.
public protocol ArmadaSqlDriver: AnyObject {
    /// Execute a statement that returns no rows.
    func run(_ sql: String, _ params: [SqlValue]) throws

    /// Execute a statement, mapping each row it produces with `read`.
    func query<T>(_ sql: String, _ params: [SqlValue], _ read: (SqlRow) throws -> T) throws -> [T]

    /// Release the underlying connection.
    func close()
}

extension ArmadaSqlDriver {
    /// Swift has no default arguments in protocol requirements, so the
    /// parameterless spellings the store uses live here.
    public func run(_ sql: String) throws {
        try run(sql, [])
    }

    public func query<T>(_ sql: String, _ read: (SqlRow) throws -> T) throws -> [T] {
        try query(sql, [], read)
    }
}

/// One row of a result set, addressed by zero-based column index.
public protocol SqlRow {
    func isNull(_ index: Int) -> Bool
    func text(_ index: Int) -> String
    func int(_ index: Int) -> Int64
}

extension SqlRow {
    /// The column as an `Int64`, or nil where SQL returned NULL.
    public func intOrNull(_ index: Int) -> Int64? {
        isNull(index) ? nil : int(index)
    }
}

/// A bound parameter.
///
/// Kotlin binds `Any?` and switches on the runtime type; Swift has no reason to
/// erase it in the first place. The literal conformances keep call sites as
/// short as the Kotlin ones — `["main", 1, nil]` builds this array directly.
public enum SqlValue: Equatable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByNilLiteral
{
    case null
    case text(String)
    case int(Int64)
    case double(Double)
    case blob([UInt8])

    public init(stringLiteral value: String) { self = .text(value) }
    public init(integerLiteral value: Int) { self = .int(Int64(value)) }
    public init(nilLiteral: ()) { self = .null }

    public init(_ value: String) { self = .text(value) }
    public init(_ value: Int) { self = .int(Int64(value)) }
    public init(_ value: Int64) { self = .int(value) }
    public init(_ value: Double) { self = .double(value) }
    public init(_ value: [UInt8]) { self = .blob(value) }

    /// A value that may be absent, so an optional column binds as NULL rather
    /// than forcing every call site to spell the branch out.
    public init(_ value: String?) { self = value.map { .text($0) } ?? .null }
    public init(_ value: Int64?) { self = value.map { .int($0) } ?? .null }
}

/// Everything the store throws.
public enum ArmadaDbError: Error, CustomStringConvertible {
    /// SQLite refused a statement. `sql` is kept because a bare code and
    /// message identify nothing in a store that prepares hundreds of shapes.
    case sqlite(code: Int32, message: String, sql: String)
    case closed
    /// The file is structurally unusable — a schema version this build predates,
    /// or a row that cannot be a rumor.
    case unusable(String)

    public var description: String {
        switch self {
        case let .sqlite(code, message, sql):
            return "ArmadaDB: SQLite error \(code): \(message) — while running: \(sql)"
        case .closed:
            return "ArmadaDB: driver is closed"
        case let .unusable(reason):
            return "ArmadaDB: \(reason)"
        }
    }
}
