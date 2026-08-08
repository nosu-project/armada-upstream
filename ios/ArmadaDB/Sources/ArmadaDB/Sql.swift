/// SQL fragment builders shared by the planner. A port of `src/lib/db/sql.ts`,
/// by way of `Sql.kt`.
enum Sql {

    /// `?, ?, ?` — a placeholder list of the given length.
    static func qs(_ length: Int) -> String {
        Array(repeating: "?", count: length).joined(separator: ", ")
    }

    /// A membership test on a column, as `= ?` for a single value and `IN (…)`
    /// for several.
    ///
    /// The distinction matters: an equality on an index column keeps the scan
    /// ordered by the columns after it, so `ORDER BY created_at DESC` comes
    /// free, whereas `IN` makes SQLite loop over the values and sort the union.
    /// Writing a one-element list as `IN (?)` measurably slows tag scans.
    static func memberOf(_ column: String, _ count: Int) -> String {
        count == 1 ? "\(column) = ?" : "\(column) IN (\(qs(count)))"
    }

    /// Join conditions into a `WHERE` clause, or nothing if there are none.
    static func whereClause(_ conditions: [String]) -> String {
        conditions.isEmpty ? "" : " WHERE \(conditions.joined(separator: " AND "))"
    }

    /// Split values into chunks that fit within a statement's parameter budget.
    /// An empty list yields NO chunks, not one empty chunk — a caller that
    /// emitted `IN ()` for it would be building invalid SQL.
    static func batch<T>(_ values: [T], _ size: Int) -> [[T]] {
        guard !values.isEmpty else { return [] }
        guard size > 0 else { return [values] }
        return stride(from: 0, to: values.count, by: size).map {
            Array(values[$0 ..< min($0 + size, values.count)])
        }
    }
}

extension String {
    /// Collapse a statement's whitespace, so its cached prepared form is reused.
    var collapsedWhitespace: String {
        var out = ""
        out.reserveCapacity(count)
        var pendingSpace = false
        for character in self {
            if character == " " || character == "\n" || character == "\t" || character == "\r" {
                pendingSpace = !out.isEmpty
            } else {
                if pendingSpace { out.append(" ") }
                pendingSpace = false
                out.append(character)
            }
        }
        return out
    }
}
