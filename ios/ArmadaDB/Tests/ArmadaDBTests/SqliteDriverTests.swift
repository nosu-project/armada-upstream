import XCTest

@testable import ArmadaDB

/// What the vendored engine has to provide before any of the store's behaviour
/// is worth testing: the SQLite version, FTS5 with `contentless_delete` and
/// `detail=none`, and JSON1. These are the capabilities Apple's platform
/// SQLite does not have on the iOS versions Armada supports, so a green run
/// here is the evidence that bundling worked rather than silently linking
/// something else.
final class SqliteEngineTests: XCTestCase {

    private func makeDriver() throws -> SqliteDriver {
        try SqliteDriver(path: ":memory:")
    }

    func testEngineIsAtLeast3_43() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        let version = try driver.query("SELECT sqlite_version()") { $0.text(0) }
        XCTAssertEqual(version.count, 1)

        let parts = version[0].split(separator: ".").compactMap { Int($0) }
        XCTAssertGreaterThanOrEqual(parts.count, 2, "unparseable version \(version[0])")
        let (major, minor) = (parts[0], parts[1])
        XCTAssertTrue(
            major > 3 || (major == 3 && minor >= 43),
            "FTS5 contentless_delete needs 3.43+, got \(version[0])"
        )
    }

    func testTagIndexIsCreatableAndDeletable() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        for statement in ArmadaDbSchema.base {
            try driver.run(statement)
        }

        // A contentless table without `contentless_delete` refuses this DELETE,
        // which is the whole reason for the version floor.
        try driver.run(
            "INSERT INTO rumor_tags_fts (rowid, tokens) VALUES (?, ?)",
            [1024, "t1:e:abc t1:p:def"]
        )
        // Two rules of the query language, both separate from `tokenchars`
        // making the token indivisible when it is INDEXED:
        //
        //  - MATCH is against the TABLE, never a column. `tokens MATCH ?`
        //    would be a column query, which `detail=none` cannot serve at all.
        //  - The token is DOUBLE-QUOTED, since FTS5 reads a bare `t1:e:abc` as
        //    the column `t1` filtered to `e`. `phrase()` in the store doubles
        //    any embedded quote for the same reason.
        let hit = try driver.query(
            "SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?", [#""t1:e:abc""#]
        ) { $0.int(0) }
        XCTAssertEqual(hit, [1024])

        try driver.run("DELETE FROM rumor_tags_fts WHERE rowid = ?", [1024])
        let afterDelete = try driver.query(
            "SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?", [#""t1:e:abc""#]
        ) { $0.int(0) }
        XCTAssertEqual(afterDelete, [])
    }

    /// `tokenchars ':_'` is what keeps a tag token indivisible. Without it
    /// `t1:e:<id>` tokenizes as three words and a `#e` filter matches any rumor
    /// that mentions the id in any tag at all.
    func testTagTokensAreIndivisible() throws {
        let driver = try makeDriver()
        defer { driver.close() }
        for statement in ArmadaDbSchema.base {
            try driver.run(statement)
        }

        try driver.run(
            "INSERT INTO rumor_tags_fts (rowid, tokens) VALUES (?, ?)",
            [2048, "t1:channel:cafe"]
        )

        let byWholeToken = try driver.query(
            "SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?", [#""t1:channel:cafe""#]
        ) { $0.int(0) }
        XCTAssertEqual(byWholeToken, [2048])

        // A different tag name carrying the same value must NOT match.
        let byOtherTag = try driver.query(
            "SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?", [#""t1:e:cafe""#]
        ) { $0.int(0) }
        XCTAssertEqual(byOtherTag, [])

        // And neither must a bare value: `tokenchars ':_'` is what keeps the
        // indexed token whole, so `cafe` alone is not a token in this index.
        let byBareValue = try driver.query(
            "SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?", [#""cafe""#]
        ) { $0.int(0) }
        XCTAssertEqual(byBareValue, [])
    }

    func testSearchIndexIsMaintainedByTriggers() throws {
        let driver = try makeDriver()
        defer { driver.close() }
        for statement in ArmadaDbSchema.base + ArmadaDbSchema.search {
            try driver.run(statement)
        }

        try driver.run(
            """
            INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [4096, 1, "abc", 1, "deadbeef", 4, "[]", "Ship it: naïve CAFÉ notes"]
        )

        // unicode61 with remove_diacritics 2 case-folds and strips accents.
        let found = try driver.query(
            "SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?", ["cafe"]
        ) { $0.int(0) }
        XCTAssertEqual(found, [4096])

        try driver.run("DELETE FROM rumors WHERE seq = ?", [4096])
        let afterDelete = try driver.query(
            "SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?", ["cafe"]
        ) { $0.int(0) }
        XCTAssertEqual(afterDelete, [])
    }

    func testJson1IsAvailable() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        let tags = try driver.query(
            "SELECT json_extract(?, '$.tags')", [#"{"tags":[["e","abc"]],"content":"hi"}"#]
        ) { $0.text(0) }
        XCTAssertEqual(tags, [#"[["e","abc"]]"#])
    }
}

/// The driver's own contract: call order on one connection, bindings that don't
/// leak between calls, and errors that name the statement.
final class SqliteDriverTests: XCTestCase {

    private func makeDriver() throws -> SqliteDriver {
        let driver = try SqliteDriver(path: ":memory:")
        try driver.run("CREATE TABLE t (a INTEGER, b TEXT)")
        return driver
    }

    func testBindsEveryValueKind() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        try driver.run("CREATE TABLE v (i INTEGER, t TEXT, d REAL, b BLOB, n INTEGER)")
        try driver.run(
            "INSERT INTO v (i, t, d, b, n) VALUES (?, ?, ?, ?, ?)",
            [.int(7), .text("seven"), .double(0.5), .blob([1, 2, 3]), .null]
        )

        let rows = try driver.query("SELECT i, t, n FROM v") {
            ($0.int(0), $0.text(1), $0.intOrNull(2))
        }
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].0, 7)
        XCTAssertEqual(rows[0].1, "seven")
        XCTAssertNil(rows[0].2)
    }

    /// A cached statement still holds the previous call's bindings, so a
    /// shorter parameter list must not inherit the longer one's tail.
    func testCachedStatementsDoNotInheritBindings() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        try driver.run("INSERT INTO t (a, b) VALUES (?, ?)", [1, "one"])
        try driver.run("INSERT INTO t (a, b) VALUES (?, ?)", [2, .null])

        let rows = try driver.query("SELECT a, b FROM t ORDER BY a") {
            ($0.int(0), $0.isNull(1) ? nil : $0.text(1))
        }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[1].0, 2)
        XCTAssertNil(rows[1].1)
    }

    /// The cache is bounded, and evicting a statement must not break the next
    /// use of the shape that was evicted.
    func testStatementCacheEvictsAndStillWorks() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        try driver.run("INSERT INTO t (a, b) VALUES (?, ?)", [1, "one"])

        // More distinct shapes than the cache holds, spelled as the store
        // spells them: an `IN (…)` list whose length varies.
        for count in 1...200 {
            let sql = "SELECT a FROM t WHERE a IN (\(Sql.qs(count)))"
            let params = (1...count).map { SqlValue.int(Int64($0)) }
            let found = try driver.query(sql, params) { $0.int(0) }
            XCTAssertEqual(found, [1])
        }
    }

    func testErrorNamesTheStatement() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        XCTAssertThrowsError(try driver.run("SELECT * FROM nope")) { error in
            guard case let ArmadaDbError.sqlite(_, _, sql) = error else {
                return XCTFail("expected a sqlite error, got \(error)")
            }
            XCTAssertEqual(sql, "SELECT * FROM nope")
        }
    }

    func testUseAfterCloseThrows() throws {
        let driver = try makeDriver()
        driver.close()
        XCTAssertThrowsError(try driver.run("SELECT 1")) { error in
            guard case ArmadaDbError.closed = error else {
                return XCTFail("expected .closed, got \(error)")
            }
        }
    }

    func testTransactionsAreOrdinaryStatements() throws {
        let driver = try makeDriver()
        defer { driver.close() }

        try driver.run("BEGIN IMMEDIATE")
        try driver.run("INSERT INTO t (a, b) VALUES (?, ?)", [1, "one"])
        // A read inside the transaction sees the write: the planner depends on
        // this, since it reads a coordinate and then supersedes it.
        let inside = try driver.query("SELECT a FROM t") { $0.int(0) }
        XCTAssertEqual(inside, [1])
        try driver.run("ROLLBACK")

        let after = try driver.query("SELECT a FROM t") { $0.int(0) }
        XCTAssertEqual(after, [])
    }
}
