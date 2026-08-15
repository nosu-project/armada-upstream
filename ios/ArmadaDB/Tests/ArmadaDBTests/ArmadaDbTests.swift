import Foundation
import XCTest

@testable import ArmadaDB

/// The conformance suite for the Swift ArmadaDB, ported from `ArmadaDbTest.kt`
/// — itself ported from `src/lib/db/ArmadaDB.test.ts` (the adapter-parity
/// suite) and `src/lib/db/SqliteArmadaDB.test.ts` (the SQLite internals the
/// parity suite can't see: query plans, index upkeep, tokenizer escaping,
/// injection).
///
/// This runs the REAL engine, not a stand-in: the vendored SQLite in
/// `CArmadaSQLite` compiles for Linux exactly as it does for iOS, so an
/// ordinary `swift test` exercises the FTS5 features (`contentless_delete`,
/// `automerge`, the `ascii tokenchars` tokenizer) and the trigger-maintained
/// search index the schema depends on — which is what makes this suite evidence
/// about the app rather than about a mock.
final class ArmadaDbTests: XCTestCase {

    private var driver: RecordingDriver?
    private var store: SqliteArmadaDb?

    private func open(search: Bool = true) throws -> SqliteArmadaDb {
        let recording = RecordingDriver(try SqliteDriver(path: ":memory:"))
        driver = recording
        let db = try SqliteArmadaDb(db: recording, search: search)
        store = db
        return db
    }

    /// The same store with a stand-in term policy, so the derived-term tests
    /// exercise the index rather than NIP-17. The engine never interprets a
    /// term — that is the contract — so any policy is as good as the real one.
    private func openWithTerms(
        _ policy: @escaping (Rumor, String) -> [String]
    ) throws -> SqliteArmadaDb {
        let recording = RecordingDriver(try SqliteDriver(path: ":memory:"))
        driver = recording
        let db = try SqliteArmadaDb(db: recording, termsOf: policy)
        store = db
        return db
    }

    override func tearDown() {
        store?.close()
        store = nil
        driver = nil
        super.tearDown()
    }

    // MARK: - Tenant stores

    func testStoresAndQueriesARumor() throws {
        let db = try open()
        let r = try rumor(id: "a")
        try db.event(tenant: "c2:abc", rumor: r)

        let got = try db.query(tenant: "c2:abc", filters: filters(#"{"kinds":[1]}"#))
        XCTAssertEqual(got.map { $0.id }, ["a"])
        XCTAssertEqual(got[0].content, r.content)
    }

    func testStripsASignatureRatherThanStoringIt() throws {
        let db = try open()
        var signed = try rumor(id: "a").toJsonObject()
        signed["sig"] = String(repeating: "f", count: 128)
        try db.event(tenant: "t", rumor: try XCTUnwrap(Rumor.parse(signed)))

        let got = try db.query(tenant: "t", filters: filters("{}"))
        XCTAssertNil(got[0].toJsonObject()["sig"])
    }

    func testQueriesAMultiLetterTag() throws {
        let db = try open()
        try db.event(
            tenant: "c2:abc", rumor: try rumor(id: "a", tags: [["channel", "chan-1"]])
        )
        try db.event(
            tenant: "c2:abc", rumor: try rumor(id: "b", tags: [["channel", "chan-2"]])
        )

        let got = try db.query(tenant: "c2:abc", filters: filters(##"{"#channel":["chan-1"]}"##))
        XCTAssertEqual(got.map { $0.id }, ["a"])
    }

    func testIsolatesRumorsBetweenTenants() throws {
        let db = try open()
        try db.event(tenant: "c2:a", rumor: try rumor(id: "a"))
        try db.event(tenant: "c2:b", rumor: try rumor(id: "b"))

        XCTAssertEqual(try db.query(tenant: "c2:a", filters: filters("{}")).map { $0.id }, ["a"])
        XCTAssertEqual(try db.query(tenant: "c2:b", filters: filters("{}")).map { $0.id }, ["b"])
        XCTAssertEqual(try db.query(tenant: "c2:c", filters: filters("{}")).map { $0.id }, [])
    }

    func testIsolatesTheTagIndexBetweenTenants() throws {
        let db = try open()
        try db.event(tenant: "c2:a", rumor: try rumor(id: "a", tags: [["channel", "chan-1"]]))
        try db.event(tenant: "c2:b", rumor: try rumor(id: "b", tags: [["channel", "chan-2"]]))

        XCTAssertEqual(
            try db.query(tenant: "c2:b", filters: filters(##"{"#channel":["chan-1"]}"##)).map {
                $0.id
            },
            []
        )
        XCTAssertEqual(
            try db.query(tenant: "c2:a", filters: filters(##"{"#channel":["chan-1"]}"##)).map {
                $0.id
            },
            ["a"]
        )
    }

    func testReturnsRumorsNewestFirstTiesBrokenBySmallerId() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "b", createdAt: 100))
        try db.event(tenant: "t", rumor: try rumor(id: "a", createdAt: 100))
        try db.event(tenant: "t", rumor: try rumor(id: "c", createdAt: 200))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["c", "a", "b"]
        )
    }

    func testAppliesEachFiltersLimit() throws {
        let db = try open()
        for i in 1...5 {
            try db.event(tenant: "t", rumor: try rumor(id: "r\(i)", createdAt: Int64(100 + i)))
        }

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"limit":2}"#)).map { $0.id },
            ["r5", "r4"]
        )
    }

    func testOrsSeveralFiltersAndDeDuplicatesById() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", createdAt: 100, kind: 1))
        try db.event(tenant: "t", rumor: try rumor(id: "b", createdAt: 200, kind: 7))

        let got = try db.query(
            tenant: "t", filters: filters(#"{"kinds":[1]}"#, #"{"kinds":[1,7]}"#)
        )
        XCTAssertEqual(got.map { $0.id }, ["b", "a"])
    }

    func testAnEmptyArrayConstraintMatchesNothing() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a"))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"ids":[]}"#)).map { $0.id }, []
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"kinds":[]}"#)).map { $0.id }, []
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(##"{"#e":[]}"##)).map { $0.id }, []
        )
    }

    func testAConstraintWhoseValuesAllFailToDecodeMatchesNothing() throws {
        // Same thing as `[]` once decoded, and the same answer: a narrowing
        // query that isn't understood must not come back with the tenant. It is
        // also what keeps the planner from emitting `IN ()`, which is not SQL.
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", kind: 1))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"kinds":["1"]}"#)).map { $0.id }, []
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"authors":[7]}"#)).map { $0.id }, []
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"ids":[null]}"#)).map { $0.id }, []
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(##"{"#e":"a"}"##)).map { $0.id }, []
        )

        // And it is the CONSTRAINT that fails, not the whole query: a filter
        // with no such key is unaffected.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"kinds":[1]}"#)).map { $0.id }, ["a"]
        )
    }

    func testHonoursIdsAuthorsKindsAndTheTimeWindow() throws {
        let db = try open()
        try db.event(
            tenant: "t", rumor: try rumor(id: "a", pubkey: "alice", createdAt: 100, kind: 1)
        )
        try db.event(
            tenant: "t", rumor: try rumor(id: "b", pubkey: "bob", createdAt: 200, kind: 1)
        )
        try db.event(
            tenant: "t", rumor: try rumor(id: "c", pubkey: "alice", createdAt: 300, kind: 7)
        )

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"ids":["b"]}"#)).map { $0.id }, ["b"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"authors":["alice"]}"#)).map { $0.id },
            ["c", "a"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"kinds":[1]}"#)).map { $0.id },
            ["b", "a"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"authors":["alice"],"kinds":[1]}"#))
                .map { $0.id },
            ["a"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"until":200}"#)).map { $0.id },
            ["b", "a"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"since":200}"#)).map { $0.id },
            ["c", "b"]
        )
    }

    func testNeverStoresAnEphemeralKind() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", kind: 20001))

        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, [])
    }

    func testStoresARumorWhoseTagValueIsTooLongToIndex() throws {
        let db = try open()
        let huge = String(repeating: "x", count: 500)
        try db.event(tenant: "t", rumor: try rumor(id: "a", tags: [["blob", huge]]))

        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["a"])
        // Indexed tags cap the value length, so the tag itself is not queryable.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: [["#blob": [huge]]]).map { $0.id }, []
        )
    }

    func testReDeliveringARumorIsANoOp() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a"))
        try db.event(tenant: "t", rumor: try rumor(id: "a"))

        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).count, 1)
        XCTAssertEqual(try db.count(tenant: "t", filters: filters("{}")).count, 1)
    }

    func testCountsAndRemoves() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", kind: 1))
        try db.event(tenant: "t", rumor: try rumor(id: "b", kind: 7))

        XCTAssertEqual(try db.count(tenant: "t", filters: filters("{}")).count, 2)
        XCTAssertEqual(try db.count(tenant: "t", filters: filters(#"{"kinds":[7]}"#)).count, 1)
        XCTAssertFalse(try db.count(tenant: "t", filters: filters("{}")).approximate)

        try db.remove(tenant: "t", filters: filters(#"{"kinds":[7]}"#))
        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["a"])
    }

    func testWritesABatchAsOneTransaction() throws {
        let db = try open()
        try db.write([
            SqliteArmadaDb.Write(tenant: "a", rumor: try rumor(id: "1")),
            SqliteArmadaDb.Write(tenant: "b", rumor: try rumor(id: "2")),
        ])

        XCTAssertEqual(try db.query(tenant: "a", filters: filters("{}")).map { $0.id }, ["1"])
        XCTAssertEqual(try db.query(tenant: "b", filters: filters("{}")).map { $0.id }, ["2"])
    }

    // MARK: - Replaceable rumors

    func testANewerReplaceableRumorSupersedesTheOlderOne() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "old", pubkey: "alice", createdAt: 100, kind: 0)
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "new", pubkey: "alice", createdAt: 200, kind: 0)
        )

        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["new"])
    }

    func testAStaleReplaceableWriteIsSkipped() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "new", pubkey: "alice", createdAt: 200, kind: 0)
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "old", pubkey: "alice", createdAt: 100, kind: 0)
        )

        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["new"])
    }

    func testEqualCreatedAtIsBrokenByTheSmallerIdAndTheStoredOneWins() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "bbb", pubkey: "alice", createdAt: 100, kind: 0)
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "aaa", pubkey: "alice", createdAt: 100, kind: 0)
        )
        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["aaa"])

        try db.event(
            tenant: "t",
            rumor: try rumor(id: "ccc", pubkey: "alice", createdAt: 100, kind: 0)
        )
        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["aaa"])
    }

    func testAddressableRumorsSupersedePerDTag() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "a1", pubkey: "alice", createdAt: 100, kind: 30000, tags: [["d", "one"]]
            )
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "b1", pubkey: "alice", createdAt: 100, kind: 30000, tags: [["d", "two"]]
            )
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "a2", pubkey: "alice", createdAt: 200, kind: 30000, tags: [["d", "one"]]
            )
        )

        XCTAssertEqual(
            Set(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }),
            ["a2", "b1"]
        )
    }

    func testSupersessionIsPerTenantAndPerAuthor() throws {
        let db = try open()
        try db.event(
            tenant: "a",
            rumor: try rumor(id: "one", pubkey: "alice", createdAt: 100, kind: 0)
        )
        try db.event(
            tenant: "b",
            rumor: try rumor(id: "two", pubkey: "alice", createdAt: 200, kind: 0)
        )
        try db.event(
            tenant: "a",
            rumor: try rumor(id: "three", pubkey: "bob", createdAt: 200, kind: 0)
        )

        XCTAssertEqual(
            Set(try db.query(tenant: "a", filters: filters("{}")).map { $0.id }),
            ["one", "three"]
        )
        XCTAssertEqual(try db.query(tenant: "b", filters: filters("{}")).map { $0.id }, ["two"])
    }

    // MARK: - NIP-09 deletion

    func testAKind5DeletesTheAuthorsOwnTargetedRumor() throws {
        let db = try open()
        try db.event(
            tenant: "t", rumor: try rumor(id: "target", pubkey: "alice", createdAt: 100)
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "del", pubkey: "alice", createdAt: 200, kind: 5, tags: [["e", "target"]]
            )
        )

        // The request itself is retained.
        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["del"])
    }

    func testAKind5CannotDeleteAnotherAuthorsRumor() throws {
        let db = try open()
        try db.event(
            tenant: "t", rumor: try rumor(id: "target", pubkey: "alice", createdAt: 100)
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "del", pubkey: "mallory", createdAt: 200, kind: 5, tags: [["e", "target"]]
            )
        )

        XCTAssertEqual(
            Set(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }),
            ["target", "del"]
        )
    }

    func testAKind5DeletesByCoordinateButSparesANewerReplacement() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "old", pubkey: "alice", createdAt: 100, kind: 30000, tags: [["d", "x"]]
            )
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "del", pubkey: "alice", createdAt: 150, kind: 5,
                tags: [["a", "30000:alice:x"]]
            )
        )
        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["del"])

        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "fresh", pubkey: "alice", createdAt: 200, kind: 30000, tags: [["d", "x"]]
            )
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "del2", pubkey: "alice", createdAt: 160, kind: 5,
                tags: [["a", "30000:alice:x"]]
            )
        )
        XCTAssertTrue(
            try db.query(tenant: "t", filters: filters("{}")).contains { $0.id == "fresh" }
        )
    }

    func testACraftedATagCannotDeleteAnotherAuthorsCoordinate() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "victim", pubkey: "alice", createdAt: 100, kind: 30000, tags: [["d", "x"]]
            )
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "del", pubkey: "mallory", createdAt: 200, kind: 5,
                tags: [["a", "30000:alice:x"]]
            )
        )

        XCTAssertTrue(
            try db.query(tenant: "t", filters: filters("{}")).contains { $0.id == "victim" }
        )
    }

    // MARK: - NIP-50 search

    func testSearchMatchesWholeWordsCaseAndAccentInsensitively() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", content: "The quick brown fox"))
        try db.event(tenant: "t", rumor: try rumor(id: "b", content: "CAFÉ society"))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"BROWN"}"#)).map { $0.id },
            ["a"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"cafe"}"#)).map { $0.id },
            ["b"]
        )
        // Whole words, not substrings.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"brow"}"#)).map { $0.id },
            []
        )
    }

    func testSearchAndsKeywordsAndHonoursNegation() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", content: "red boat"))
        try db.event(tenant: "t", rumor: try rumor(id: "b", content: "red anchor"))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"red -anchor"}"#)).map {
                $0.id
            },
            ["a"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"red sail"}"#)).map { $0.id },
            []
        )
    }

    func testSearchIntersectsWithATagDrivenScanAndIsTenantScoped() throws {
        let db = try open()
        try db.event(
            tenant: "a",
            rumor: try rumor(id: "hit", tags: [["channel", "c1"]], content: "red boat")
        )
        try db.event(
            tenant: "a",
            rumor: try rumor(id: "miss", tags: [["channel", "c1"]], content: "blue boat")
        )
        try db.event(tenant: "b", rumor: try rumor(id: "other", content: "red boat"))

        XCTAssertEqual(
            try db.query(
                tenant: "a", filters: filters(##"{"#channel":["c1"],"search":"red"}"##)
            ).map { $0.id },
            ["hit"]
        )
        XCTAssertEqual(
            try db.query(tenant: "b", filters: filters(#"{"search":"red"}"#)).map { $0.id },
            ["other"]
        )
    }

    func testASearchParsingToNoKeywordsFailsClosed() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", content: "anything"))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"domain:example.com"}"#))
                .map { $0.id },
            []
        )
        // A blank search asked for nothing, so it constrains nothing.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"  "}"#)).map { $0.id },
            ["a"]
        )
    }

    func testSearchStillWorksWithTheContentIndexOff() throws {
        let db = try open(search: false)
        try db.event(tenant: "t", rumor: try rumor(id: "a", content: "The quick brown fox"))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"brown"}"#)).map { $0.id },
            ["a"]
        )
        // Without the index it is a substring match, matching IndexedDB.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"brow"}"#)).map { $0.id },
            ["a"]
        )
    }

    func testARemovedRumorDisappearsFromTheSearchIndex() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", content: "findable"))
        try db.remove(tenant: "t", filters: filters(#"{"ids":["a"]}"#))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"findable"}"#)).map { $0.id },
            []
        )
    }

    // MARK: - Query plans

    func testTheTokenIndexDrivesATagFilterAndRumorsIsNeverScanned() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", tags: [["channel", "c1"]]))

        let plans = try XCTUnwrap(driver).record {
            _ = try db.query(
                tenant: "t", filters: self.filters(##"{"#channel":["c1"],"kinds":[1]}"##)
            )
        }

        XCTAssertTrue(plans.contains { $0.contains("rumor_tags_fts") })
        XCTAssertFalse(plans.contains { $0.contains("SCAN rumors") })
    }

    func testAnAuthorIsFoldedIntoTheSameMatchAsATag() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "a", pubkey: "alice", tags: [["channel", "c1"]])
        )

        let recording = try XCTUnwrap(driver)
        _ = try recording.record {
            _ = try db.query(
                tenant: "t", filters: self.filters(##"{"#channel":["c1"],"authors":["alice"]}"##)
            )
        }

        let match = try XCTUnwrap(recording.lastMatchExpression())
        XCTAssertTrue(match.contains(":_p:alice"), match)
        XCTAssertTrue(match.contains(":channel:c1"), match)
    }

    func testAFilterNamingOnlyAuthorsAndKindsUsesTheCompositeIndex() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", pubkey: "alice"))

        let plans = try XCTUnwrap(driver).record {
            _ = try db.query(
                tenant: "t", filters: self.filters(#"{"authors":["alice"],"kinds":[1]}"#)
            )
        }
        XCTAssertTrue(plans.contains { $0.contains("rumors_pubkey_kind") })
    }

    func testAnUnconstrainedFilterWalksTheTenantIndex() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a"))

        let plans = try XCTUnwrap(driver).record {
            _ = try db.query(tenant: "t", filters: self.filters("{}"))
        }
        XCTAssertTrue(plans.contains { $0.contains("rumors_tenant") })
    }

    func testATagFilterOnATenantThatWasNeverWrittenShortCircuits() throws {
        let db = try open()
        try db.event(tenant: "other", rumor: try rumor(id: "a", tags: [["channel", "c1"]]))

        let recording = try XCTUnwrap(driver)
        _ = try recording.record {
            _ = try db.query(tenant: "empty", filters: self.filters(##"{"#channel":["c1"]}"##))
        }

        // The tenant lookup is the only statement: with no interned ordinal
        // there are no tokens to match, so neither the index nor the table is
        // touched at all.
        XCTAssertFalse(recording.selects.contains { $0.sql.contains("rumors") })
    }

    func testCountingACompletePlanNeverReadsARumorBody() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", tags: [["channel", "c1"]]))

        let recording = try XCTUnwrap(driver)
        _ = try recording.record {
            XCTAssertEqual(
                try db.count(tenant: "t", filters: self.filters(##"{"#channel":["c1"]}"##)).count,
                1
            )
        }
        XCTAssertFalse(recording.selects.contains { $0.sql.contains("content") })
    }

    // MARK: - Index upkeep

    func testNoTokenRowOutlivesSupersession() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "old", pubkey: "alice", createdAt: 100, kind: 0, tags: [["channel", "c1"]]
            )
        )
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "new", pubkey: "alice", createdAt: 200, kind: 0, tags: [["channel", "c2"]]
            )
        )

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(##"{"#channel":["c1"]}"##)).map { $0.id },
            []
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(##"{"#channel":["c2"]}"##)).map { $0.id },
            ["new"]
        )
    }

    func testNoTokenOrCoordinateRowOutlivesRemoval() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "a", pubkey: "alice", kind: 30000,
                tags: [["d", "x"], ["channel", "c1"]]
            )
        )
        try db.remove(tenant: "t", filters: filters(#"{"ids":["a"]}"#))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(##"{"#channel":["c1"]}"##)).map { $0.id },
            []
        )
        XCTAssertEqual(try rowCount("rumor_coords"), 0)
        XCTAssertEqual(try rowCount("rumors"), 0)

        // The coordinate is free again.
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "b", pubkey: "alice", createdAt: 50, kind: 30000, tags: [["d", "x"]]
            )
        )
        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, ["b"])
    }

    func testWipeEmptiesEveryTable() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", tags: [["channel", "c1"]]))
        try db.kvSet("k", "1")
        try db.wipe()

        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map { $0.id }, [])
        XCTAssertEqual(try db.kvList(), [])
        XCTAssertEqual(try db.tenantIds(), [])
        XCTAssertEqual(try rowCount("rumors"), 0)
        XCTAssertEqual(try rowCount("rumor_coords"), 0)

        // The tenant interning starts over without naming the wrong namespace.
        try db.event(tenant: "u", rumor: try rumor(id: "b", tags: [["channel", "c1"]]))
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(##"{"#channel":["c1"]}"##)).map { $0.id },
            []
        )
        XCTAssertEqual(
            try db.query(tenant: "u", filters: filters(##"{"#channel":["c1"]}"##)).map { $0.id },
            ["b"]
        )
    }

    // MARK: - Injection

    func testAHostileTagValueIsEscapedRatherThanTokenized() throws {
        let db = try open()
        let hostile = #"c1" OR "x" AND (b"#
        try db.event(tenant: "t", rumor: try rumor(id: "a", tags: [["channel", hostile]]))
        try db.event(tenant: "t", rumor: try rumor(id: "b", tags: [["channel", "c1"]]))

        let got = try db.query(tenant: "t", filters: [["#channel": [hostile]]])
        XCTAssertEqual(got.map { $0.id }, ["a"])
    }

    func testATagCannotForgeAnotherRumorsAuthorToken() throws {
        let db = try open()
        try db.event(
            tenant: "t",
            rumor: try rumor(id: "victim", pubkey: "alice", tags: [["channel", "c1"]])
        )
        // A tag literally named `_p` would collide with the reserved author
        // prefix if names weren't escaped.
        try db.event(
            tenant: "t",
            rumor: try rumor(
                id: "forged", pubkey: "mallory",
                tags: [["_p", "alice"], ["channel", "c1"]]
            )
        )

        let got = try db.query(
            tenant: "t", filters: filters(##"{"#channel":["c1"],"authors":["alice"]}"##)
        )
        XCTAssertEqual(got.map { $0.id }, ["victim"])
    }

    func testAForgedTokenPrefixCannotReachAnotherTenant() throws {
        let db = try open()
        try db.event(
            tenant: "main", rumor: try rumor(id: "secret", tags: [["channel", "private"]])
        )
        // `t0`/`t1` are what the tenant prefixes look like; a tag value spelling
        // one out must not become another tenant's posting list.
        try db.event(
            tenant: "evil",
            rumor: try rumor(id: "probe", tags: [["t1", "channel:private"]])
        )

        XCTAssertEqual(
            try db.query(tenant: "evil", filters: filters(##"{"#channel":["private"]}"##)).map {
                $0.id
            },
            []
        )
        XCTAssertEqual(
            try db.query(tenant: "main", filters: filters(##"{"#channel":["private"]}"##)).map {
                $0.id
            },
            ["secret"]
        )
    }

    func testControlCharactersSurviveEveryUserControlledString() throws {
        let db = try open()
        let nasty = "a\u{0}b\u{1F}\"'\\;--\n\t"
        try db.event(
            tenant: nasty,
            rumor: try rumor(
                id: nasty, pubkey: nasty, tags: [[nasty, nasty]], content: nasty
            )
        )

        let got = try db.query(tenant: nasty, filters: [["#\(nasty)": [nasty]]])
        XCTAssertEqual(got.map { $0.id }, [nasty])
        XCTAssertEqual(got[0].content, nasty)
    }

    func testANulInASearchFallsBackToTheInMemoryMatch() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a", content: "hello"))

        // FTS5's query parser is NUL-terminated, so such a keyword can't be put
        // to the index at all; it is matched in memory instead, where it matches
        // nothing rather than quietly searching for "hel".
        XCTAssertEqual(
            try db.query(tenant: "t", filters: [["search": "hel\u{0}lo"]]).map { $0.id }, []
        )
    }

    func testAHostileKvKeyRoundTrips() throws {
        let db = try open()
        let key = "k\u{0}'\";--"
        try db.kvSet(key, #"{"a":1}"#)

        XCTAssertEqual(try db.kvGet(key), #"{"a":1}"#)
        XCTAssertEqual(try db.kvList(prefix: "k"), [KvEntry(key: key, json: #"{"a":1}"#)])
    }

    // MARK: - KV

    func testKvGetsSetsOverwritesAndDeletes() throws {
        let db = try open()
        XCTAssertNil(try db.kvGet("missing"))

        try db.kvSet("a", "1")
        XCTAssertEqual(try db.kvGet("a"), "1")

        try db.kvSet("a", "2")
        XCTAssertEqual(try db.kvGet("a"), "2")

        try db.kvDelete("a")
        XCTAssertNil(try db.kvGet("a"))
        // Deleting a key that was never set is a no-op, not an error.
        try db.kvDelete("a")
    }

    func testKvEntriesArePrefixScannedAndOrdered() throws {
        let db = try open()
        for key in ["b:1", "a:2", "a:1", "a:10"] { try db.kvSet(key, "null") }

        XCTAssertEqual(try db.kvList().map { $0.key }, ["a:1", "a:10", "a:2", "b:1"])
        XCTAssertEqual(try db.kvList(prefix: "a:").map { $0.key }, ["a:1", "a:10", "a:2"])
        XCTAssertEqual(try db.kvList(prefix: "zzz"), [])
    }

    func testKvListCarriesTheValueWithTheKey() throws {
        let db = try open()
        try db.kvSet("a:1", #"{"since":7}"#)
        try db.kvSet("a:2", "null")

        // The JSON text, verbatim: nothing native parses or respells it.
        XCTAssertEqual(
            try db.kvList(prefix: "a:"),
            [KvEntry(key: "a:1", json: #"{"since":7}"#), KvEntry(key: "a:2", json: "null")]
        )
    }

    func testAPrefixIsABoundaryNotASubstring() throws {
        let db = try open()
        try db.kvSet("ab", "null")
        try db.kvSet("b", "null")

        XCTAssertEqual(try db.kvList(prefix: "a").map { $0.key }, ["ab"])
    }

    func testKvListScansAHalfOpenRange() throws {
        let db = try open()
        for key in ["a", "b", "c", "d"] { try db.kvSet(key, "null") }

        // `start` inclusive, `end` exclusive.
        XCTAssertEqual(try db.kvList(start: "b", end: "d").map { $0.key }, ["b", "c"])
        XCTAssertEqual(try db.kvList(start: "c").map { $0.key }, ["c", "d"])
        XCTAssertEqual(try db.kvList(end: "b").map { $0.key }, ["a"])
    }

    func testKvListResumesAPrefixScanFromACursor() throws {
        let db = try open()
        for n in 1...4 { try db.kvSet("log:\(n)", "null") }

        XCTAssertEqual(
            try db.kvList(prefix: "log:", start: "log:3").map { $0.key }, ["log:3", "log:4"]
        )
        XCTAssertEqual(
            try db.kvList(prefix: "log:", end: "log:3").map { $0.key }, ["log:1", "log:2"]
        )
    }

    func testKvOpsExecutesAMixedBatchInArrivalOrder() throws {
        let db = try open()

        // Read-your-writes inside one batch: each get sees the set before it.
        let results = try db.kvOps([
            .set(key: "a", json: "1"),
            .get(key: "a"),
            .set(key: "a", json: "2"),
            .get(key: "a"),
            .delete(key: "a"),
            .get(key: "a"),
        ])

        XCTAssertEqual(results.map(value), [nil, "1", nil, "2", nil, nil])
        XCTAssertNil(try db.kvGet("a"))
    }

    func testKvOpsScanSeesEarlierWritesInTheSameBatch() throws {
        let db = try open()

        let results = try db.kvOps([
            .set(key: "p:1", json: "1"),
            .set(key: "p:2", json: "2"),
            .scan(prefix: "p:"),
        ])

        XCTAssertEqual(
            try entries(results[2]),
            [KvEntry(key: "p:1", json: "1"), KvEntry(key: "p:2", json: "2")]
        )
    }

    func testKvOpsAnswersAReadOnlyBatchWithoutATransaction() throws {
        let db = try open()
        try db.kvSet("k", #""v""#)

        let recording = try XCTUnwrap(driver)
        recording.statements.removeAll()

        let results = try db.kvOps([
            .get(key: "k"),
            .get(key: "missing"),
            .scan(prefix: "zzz"),
        ])

        XCTAssertEqual(value(results[0]), #""v""#)
        XCTAssertNil(value(results[1]))
        XCTAssertEqual(try entries(results[2]), [])
        XCTAssertFalse(recording.statements.contains { $0.hasPrefix("BEGIN") })
    }

    func testKvOpsScanHonorsRangeLimitAndReverseLikeKvList() throws {
        let db = try open()
        for n in 1...4 { try db.kvSet("log:\(n)", "null") }

        let results = try db.kvOps([
            .scan(prefix: "log:", start: "log:3"),
            .scan(prefix: "log:", limit: 2),
            .scan(prefix: "log:", limit: 1, reverse: true),
        ])

        XCTAssertEqual(try entries(results[0]).map { $0.key }, ["log:3", "log:4"])
        XCTAssertEqual(try entries(results[1]).map { $0.key }, ["log:1", "log:2"])
        XCTAssertEqual(try entries(results[2]).map { $0.key }, ["log:4"])
    }

    func testARangeBoundStaysInsideItsPrefix() throws {
        let db = try open()
        try db.kvSet("p:1", "null")
        try db.kvSet("q:1", "null")

        // A bound outside the prefix narrows to nothing rather than escaping it.
        XCTAssertEqual(try db.kvList(prefix: "p:", start: "q:"), [])
        XCTAssertEqual(try db.kvList(prefix: "p:", end: "a"), [])
        XCTAssertEqual(try db.kvList(prefix: "p:", start: "a").map { $0.key }, ["p:1"])
    }

    func testKvListIsEmptyWhenTheBoundsCross() throws {
        let db = try open()
        try db.kvSet("b", "null")

        XCTAssertEqual(try db.kvList(start: "z", end: "a"), [])
        XCTAssertEqual(try db.kvList(start: "b", end: "b"), [])
    }

    func testKvListRefusesAPrefixGivenBothBounds() throws {
        let db = try open()

        // The bounds already describe the range; a prefix on top of them is
        // either redundant or a contradiction.
        XCTAssertThrowsError(try db.kvList(prefix: "p:", start: "p:1", end: "p:9")) { error in
            guard case ArmadaDbError.unusable = error else {
                return XCTFail("expected .unusable, got \(error)")
            }
        }
    }

    func testKvListLimitsAndReverses() throws {
        let db = try open()
        for n in 1...3 { try db.kvSet("p:\(n)", "null") }

        XCTAssertEqual(try db.kvList(prefix: "p:", limit: 2).map { $0.key }, ["p:1", "p:2"])
        XCTAssertEqual(try db.kvList(prefix: "p:", limit: 0), [])
        XCTAssertEqual(
            try db.kvList(prefix: "p:", reverse: true).map { $0.key }, ["p:3", "p:2", "p:1"]
        )
        // A limit takes from the front of the order it was asked for, so
        // reversing makes it the LAST entries.
        XCTAssertEqual(
            try db.kvList(prefix: "p:", limit: 1, reverse: true).map { $0.key }, ["p:3"]
        )
    }

    func testAPrefixEndingInTheMaximalCodeUnitScansOpenEnded() throws {
        let db = try open()
        let prefix = "x\u{FFFF}"
        try db.kvSet("\(prefix)1", "null")
        try db.kvSet("y", "null")

        // There is no exclusive upper bound for this prefix, so the range is
        // open-ended and everything above it is read and then filtered. What
        // comes back must still be only genuine matches — never the tail of the
        // store, and never a page filled out to `limit` from beyond the prefix.
        XCTAssertEqual(try db.kvList(prefix: prefix).map { $0.key }, ["\(prefix)1"])
        XCTAssertEqual(try db.kvList(prefix: prefix, limit: 2).map { $0.key }, ["\(prefix)1"])

        // ENGINE NOTE: U+FFFF round-trips here, where the Kotlin port records
        // that androidx's JNI boundary replaces it with U+FFFD. This driver
        // hands SQLite UTF-8 bytes directly, so there is no such boundary, and
        // the key comes back verbatim — matching the web build's adapters
        // rather than Android's.
        XCTAssertEqual(try db.kvList().map { $0.key }, ["\(prefix)1", "y"])
    }

    // MARK: - Schema

    /// The one deliberate divergence from the other two ports: they carry a v0
    /// → v1 rebuild, and this refuses a v0 file instead. No iOS build has ever
    /// written one, so the migration could only ever run on a file this
    /// platform did not produce — and `CREATE IF NOT EXISTS` over an unknown
    /// layout succeeds silently and then misreads every row.
    func testRefusesAV0File() throws {
        let raw = try SqliteDriver(path: ":memory:")
        defer { raw.close() }

        try raw.run(
            """
            CREATE TABLE rumors ( seq INTEGER PRIMARY KEY, tenant TEXT NOT NULL,
                id TEXT NOT NULL, kind INTEGER NOT NULL, pubkey TEXT NOT NULL,
                created_at INTEGER NOT NULL, json TEXT NOT NULL )
            """
        )

        XCTAssertThrowsError(try SqliteArmadaDb(db: raw)) { error in
            guard case let ArmadaDbError.unusable(reason) = error else {
                return XCTFail("expected .unusable, got \(error)")
            }
            XCTAssertTrue(reason.contains("v0"), reason)
        }
    }

    /// A file written by a LATER schema version is refused too, rather than
    /// opened and misread.
    func testRefusesAFutureSchemaVersion() throws {
        let raw = try SqliteDriver(path: ":memory:")
        defer { raw.close() }
        try raw.run("PRAGMA user_version = 99")

        XCTAssertThrowsError(try SqliteArmadaDb(db: raw)) { error in
            guard case let ArmadaDbError.unusable(reason) = error else {
                return XCTFail("expected .unusable, got \(error)")
            }
            XCTAssertTrue(reason.contains("99"), reason)
        }
    }

    func testStampsTheSchemaVersionOnAFreshFile() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: try rumor(id: "a"))

        let recording = try XCTUnwrap(driver)
        XCTAssertEqual(
            try recording.query("PRAGMA user_version") { $0.int(0) }.first,
            ArmadaDbSchema.version
        )
    }

    // MARK: - Derived terms
    //
    // The term index: facts a policy computes from a rumor, queried as NIP-50
    // extension tokens. Ported from `ArmadaDB.test.ts`'s "derived terms" block
    // and `ArmadaDbTest.kt`'s, and NIP-17-free for the same reason it is there
    // — the engine never interprets a term.

    /// Files each rumor under the sorted set of its `p` tags.
    private let peersPolicy: (Rumor, String) -> [String] = { rumor, _ in
        let set = Set(rumor.tags.filter { $0.first == "p" }.compactMap { $0.count >= 2 ? $0[1] : nil })
        return set.isEmpty ? [] : ["conv:" + set.sorted().joined()]
    }

    /// Every `p` tag as its own term, so one rumor carries several.
    private let eachPolicy: (Rumor, String) -> [String] = { rumor, _ in
        rumor.tags.filter { $0.first == "p" }.compactMap { $0.count >= 2 ? $0[1] : nil }
            .map { "with:\($0)" }
    }

    func testSelectsExactlyTheRumorsAPolicyFiledUnderATerm() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(tenant: "t", rumor: rumor(id: "pair", tags: [["p", "ana"], ["p", "ben"]]))
        try db.event(tenant: "t", rumor: rumor(id: "ana", tags: [["p", "ana"]]))
        try db.event(tenant: "t", rumor: rumor(id: "ben", tags: [["p", "ben"]]))

        // The exact set, and neither of the 1:1s that share its members — which
        // is the whole thing a tag filter cannot express.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"conv:anaben"}"#)).map(\.id),
            ["pair"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            ["ana"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"conv:ben"}"#)).map(\.id),
            ["ben"]
        )
    }

    func testRequiresEveryTermAFilterNames() throws {
        let db = try openWithTerms(eachPolicy)
        try db.event(
            tenant: "t",
            rumor: rumor(id: "both", createdAt: 200, tags: [["p", "ana"], ["p", "ben"]])
        )
        try db.event(tenant: "t", rumor: rumor(id: "one", createdAt: 100, tags: [["p", "ana"]]))

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"with:ana"}"#)).map(\.id),
            ["both", "one"]
        )
        // Conditions within a filter AND, terms included.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"with:ana with:ben"}"#)).map(\.id),
            ["both"]
        )
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"with:ana with:cy"}"#)).map(\.id),
            []
        )
    }

    func testMatchesNothingForATermInATenantThatDerivesNone() throws {
        let db = try open()
        try db.event(tenant: "t", rumor: rumor(id: "a", tags: [["p", "ana"]]))

        // Fails closed, exactly like an unsupported NIP-50 extension: a
        // narrowing query that can't be honored answers with nothing.
        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            []
        )
        XCTAssertEqual(try db.count(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).count, 0)
    }

    func testATermCannotBeForgedByATagTheSenderWrote() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(tenant: "t", rumor: rumor(id: "real", tags: [["p", "ana"]]))
        // A sender claiming a term for a conversation they are not in. Terms
        // live in their own table, so there is nothing here for a tag to reach.
        try db.event(
            tenant: "t",
            rumor: rumor(id: "fake", tags: [["conv", "ana"], ["~", "conv:ana"]])
        )

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            ["real"]
        )
    }

    func testNarrowsATermAlongsideTheFiltersOtherConstraints() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(
            tenant: "t",
            rumor: rumor(id: "kept", pubkey: "ana", kind: 14, tags: [["p", "ana"]])
        )
        try db.event(
            tenant: "t",
            rumor: rumor(id: "wrongkind", pubkey: "ana", kind: 7, tags: [["p", "ana"]])
        )
        try db.event(
            tenant: "t",
            rumor: rumor(id: "wrongauthor", pubkey: "ben", kind: 14, tags: [["p", "ana"]])
        )
        try db.event(
            tenant: "t",
            rumor: rumor(id: "wrongconv", pubkey: "ana", kind: 14, tags: [["p", "ben"]])
        )

        XCTAssertEqual(
            try db.query(
                tenant: "t",
                filters: filters(#"{"search":"conv:ana","kinds":[14],"authors":["ana"]}"#)
            ).map(\.id),
            ["kept"]
        )
    }

    func testAppliesTheLimitToTheTermsOwnRows() throws {
        let db = try openWithTerms(peersPolicy)
        // Interleaved, so a limit applied before the term would come back short.
        for i in 0..<6 {
            try db.event(
                tenant: "t",
                rumor: rumor(id: "ana-\(i)", createdAt: Int64(100 + i * 2), tags: [["p", "ana"]])
            )
            try db.event(
                tenant: "t",
                rumor: rumor(id: "ben-\(i)", createdAt: Int64(101 + i * 2), tags: [["p", "ben"]])
            )
        }

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"conv:ana","limit":3}"#)).map(\.id),
            ["ana-5", "ana-4", "ana-3"]
        )
    }

    func testDrivesATermLookupOffItsOwnIndex() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(tenant: "t", rumor: rumor(id: "a", tags: [["p", "ana"]]))
        let recording = try XCTUnwrap(driver)
        recording.selects.removeAll()
        _ = try db.query(tenant: "t", filters: filters(#"{"search":"conv:ana","limit":10}"#))

        // The CROSS JOIN is what fixes the join order: the rumors table must be
        // the inner side, seeked by rowid, or a condition on one of its columns
        // makes the planner drive from there and sort afterwards.
        let scan = try XCTUnwrap(recording.selects.first { $0.sql.contains("rumor_terms x") }).sql
        XCTAssertTrue(scan.contains("CROSS JOIN rumors r ON r.seq = x.seq"), scan)
        XCTAssertTrue(scan.contains("ORDER BY x.seq DESC"), scan)
        XCTAssertTrue(scan.contains("LIMIT ?"), scan)
    }

    func testCountsAndRemovesByTerm() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(tenant: "t", rumor: rumor(id: "ana", tags: [["p", "ana"]]))
        try db.event(tenant: "t", rumor: rumor(id: "ben", tags: [["p", "ben"]]))

        XCTAssertEqual(try db.count(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).count, 1)
        try db.remove(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#))
        XCTAssertEqual(try db.query(tenant: "t", filters: filters("{}")).map(\.id), ["ben"])
    }

    func testForgetsATermWhenItsRumorIsDeleted() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(tenant: "t", rumor: rumor(id: "gone", pubkey: "ana", tags: [["p", "ana"]]))
        try db.event(
            tenant: "t",
            rumor: rumor(id: "req", pubkey: "ana", kind: 5, tags: [["e", "gone"]])
        )

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            []
        )
        // The trigger cleared the index row, not just the rumor.
        XCTAssertEqual(try rowCount("rumor_terms"), 0)
    }

    func testKeepsATermInsideItsOwnTenant() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(tenant: "a", rumor: rumor(id: "mine", tags: [["p", "ana"]]))
        try db.event(tenant: "b", rumor: rumor(id: "theirs", tags: [["p", "ana"]]))

        XCTAssertEqual(
            try db.query(tenant: "a", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            ["mine"]
        )
    }

    func testCombinesATermWithAKeyword() throws {
        let db = try openWithTerms(peersPolicy)
        try db.event(
            tenant: "t",
            rumor: rumor(id: "hit", tags: [["p", "ana"]], content: "the quick brown fox")
        )
        try db.event(
            tenant: "t",
            rumor: rumor(id: "otherconv", tags: [["p", "ben"]], content: "the quick brown fox")
        )
        try db.event(
            tenant: "t",
            rumor: rumor(id: "othertext", tags: [["p", "ana"]], content: "nothing here")
        )

        XCTAssertEqual(
            try db.query(tenant: "t", filters: filters(#"{"search":"brown conv:ana"}"#)).map(\.id),
            ["hit"]
        )
    }

    func testIndexesRowsAlreadyStoredWhenThePolicyArrived() throws {
        // The extension and the WebView open the same file, and a policy can be
        // added by an app update — so the rows already there have to be walked
        // once. Reads that name a term wait for that; ordinary reads don't.
        let recording = RecordingDriver(try SqliteDriver(path: ":memory:"))
        driver = recording
        let before = try SqliteArmadaDb(db: recording)
        store = before
        try before.event(tenant: "t", rumor: rumor(id: "old", createdAt: 100, tags: [["p", "ana"]]))

        let after = try SqliteArmadaDb(db: recording, termsOf: peersPolicy)
        store = after
        try after.event(tenant: "t", rumor: rumor(id: "fresh", createdAt: 200, tags: [["p", "ana"]]))

        XCTAssertEqual(
            try after.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            ["fresh", "old"]
        )

        // And only once: the second store recorded that it walked the tenant.
        let third = try SqliteArmadaDb(
            db: recording,
            termsOf: { _, _ in
                XCTFail("the tenant was walked a second time")
                return []
            }
        )
        store = third
        XCTAssertEqual(
            try third.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            ["fresh", "old"]
        )
    }

    func testReDerivesEveryTermWhenTheGenerationChanges() throws {
        let recording = RecordingDriver(try SqliteDriver(path: ":memory:"))
        driver = recording
        let first = try SqliteArmadaDb(db: recording, termsOf: peersPolicy, termsGeneration: 1)
        store = first
        try first.event(tenant: "t", rumor: rumor(id: "stored", tags: [["p", "ana"]]))
        XCTAssertEqual(
            try first.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            ["stored"]
        )

        // The same rows, a different derivation. Both halves matter: the new
        // term has to reach rows written before it, and the old one has to STOP
        // matching — an index that only ever gains terms would keep answering a
        // lookup no policy derives any more.
        let renamed = try SqliteArmadaDb(db: recording, termsOf: eachPolicy, termsGeneration: 2)
        store = renamed
        XCTAssertEqual(
            try renamed.query(tenant: "t", filters: filters(#"{"search":"with:ana"}"#)).map(\.id),
            ["stored"]
        )
        XCTAssertEqual(
            try renamed.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            []
        )
    }

    func testLeavesTheIndexAloneWhenTheGenerationIsUnchanged() throws {
        let recording = RecordingDriver(try SqliteDriver(path: ":memory:"))
        driver = recording
        let first = try SqliteArmadaDb(db: recording, termsOf: peersPolicy, termsGeneration: 1)
        store = first
        try first.event(
            tenant: "t", rumor: rumor(id: "stored", createdAt: 100, tags: [["p", "ana"]])
        )
        _ = try first.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#))

        // A different policy at the SAME generation: the marker says this tenant
        // is done, so the pass doesn't run and the stored row keeps the terms it
        // was written with. That is what makes the backfill once-per-file rather
        // than once-per-launch — the generation is the only thing that reopens
        // it.
        let same = try SqliteArmadaDb(db: recording, termsOf: eachPolicy, termsGeneration: 1)
        store = same
        try same.event(
            tenant: "t", rumor: rumor(id: "later", createdAt: 200, tags: [["p", "ana"]])
        )

        XCTAssertEqual(
            try same.query(tenant: "t", filters: filters(#"{"search":"conv:ana"}"#)).map(\.id),
            ["stored"]
        )
        XCTAssertEqual(
            try same.query(tenant: "t", filters: filters(#"{"search":"with:ana"}"#)).map(\.id),
            ["later"]
        )
    }

    func testPinsTheTermGenerationToTheOtherPorts() {
        // One number, written into a file three engines share: two ports that
        // disagree would each read the other's as stale and rebuild the index on
        // every open. `TERM_GENERATION` in `src/lib/db/termPolicies.ts` and
        // `TermPolicies.GENERATION` in Kotlin are this literal.
        XCTAssertEqual(TermPolicies.generation, 1)
    }

    // MARK: - NIP-17 conversation terms
    //
    // These must agree with `src/lib/nip17/conversation.ts` and `Dm17.kt`
    // exactly. The term this derivation produces is what a rumor is FILED
    // under, and the WebView looks it up by deriving it independently — so a
    // divergence is a message received while the app was closed that the thread
    // never shows.

    func testAGroupIsTheParticipantSetFromEitherDirection() throws {
        let me = "self"
        // Received: the sender joins the room whether or not they p-tagged
        // themselves, and the viewer is never their own peer.
        let received = try rumor(id: "r", pubkey: "alice", tags: [["p", me], ["p", "bob"]])
        XCTAssertEqual(Dm17Conversation.peers(of: received, self: me), ["alice", "bob"])

        // Our own copy of the same room reduces to the same set, which is what
        // makes both halves of one conversation one conversation.
        let mine = try rumor(id: "m", pubkey: me, tags: [["p", "alice"], ["p", "bob"]])
        XCTAssertEqual(Dm17Conversation.peers(of: mine, self: me), ["alice", "bob"])
        XCTAssertEqual(
            Dm17Conversation.term(["alice", "bob"]),
            Dm17Conversation.term(["bob", "alice"])
        )
    }

    func testNoteToSelfIsItsOwnConversation() throws {
        let me = "self"
        let note = try rumor(id: "n", pubkey: me, tags: [["p", me]])
        XCTAssertEqual(Dm17Conversation.peers(of: note, self: me), [me])
    }

    func testAOneToOneTermIsThePeerAloneUnseparated() {
        // Pubkeys are fixed-width hex, so a set is joined with nothing — a term
        // crosses a NIP-50 search string, whose parse ends a token at
        // whitespace.
        XCTAssertEqual(Dm17Conversation.term(["alice"]), "conv:alice")
        XCTAssertEqual(Dm17Conversation.term(["bob", "alice"]), "conv:alicebob")
    }

    func testFilesARumorUnderTheConversationItsTenantNames() throws {
        let me = "self"
        let received = try rumor(id: "r", pubkey: "alice", tags: [["p", me], ["p", "bob"]])
        XCTAssertEqual(
            TermPolicies.terms(of: received, tenantId: "dm17:\(me)"),
            ["conv:alicebob"]
        )
        // A tenant that derives no terms says so, rather than guessing.
        XCTAssertEqual(TermPolicies.terms(of: received, tenantId: "main"), [])
    }

    func testAnUnattributableRumorIsFiledUnderNothing() throws {
        let me = "self"
        let orphan = try rumor(id: "o", pubkey: me)
        XCTAssertNil(Dm17Conversation.peers(of: orphan, self: me))
        XCTAssertEqual(TermPolicies.terms(of: orphan, tenantId: "dm17:\(me)"), [])
    }

    // MARK: - Helpers

    private func rowCount(_ table: String) throws -> Int64 {
        try XCTUnwrap(
            try XCTUnwrap(driver).query("SELECT COUNT(*) FROM \(table)") { $0.int(0) }.first
        )
    }

    /// Filters from JSON text.
    ///
    /// A literal that fails to parse fails the TEST rather than degrading to
    /// `{}` — an unconstrained filter matches the whole tenant, so a typo in a
    /// narrowing filter would otherwise be indistinguishable from the store
    /// answering it correctly.
    private func filters(
        _ json: String...,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> [[String: Any]] {
        json.map { text in
            guard let decoded = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
                let filter = decoded as? [String: Any]
            else {
                XCTFail("unparseable filter literal: \(text)", file: file, line: line)
                return [:]
            }
            return filter
        }
    }

    private func rumor(
        id: String,
        pubkey: String = "alice",
        createdAt: Int64 = 1000,
        kind: Int = 1,
        tags: [[String]] = [],
        content: String = "hello"
    ) throws -> Rumor {
        try XCTUnwrap(
            Rumor.of(
                id: id, pubkey: pubkey, createdAt: createdAt, kind: kind, tags: tags,
                content: content
            )
        )
    }

    private func value(_ result: SqliteArmadaDb.KvResult) -> String? {
        if case let .value(json) = result { return json }
        return nil
    }

    private func entries(_ result: SqliteArmadaDb.KvResult) throws -> [KvEntry] {
        guard case let .entries(entries) = result else {
            throw XCTSkip("expected entries, got \(result)")
        }
        return entries
    }
}

/// A driver that remembers the statements a call issued, so a plan can be
/// asserted rather than inferred from timings — the whole point of forcing
/// indexes and of the `CROSS JOIN`.
final class RecordingDriver: ArmadaSqlDriver {
    private let inner: ArmadaSqlDriver

    /// Every statement, in order, for asserting on transactions.
    var statements: [String] = []
    /// Just the SELECTs, with their parameters, for replaying as EXPLAIN.
    var selects: [(sql: String, params: [SqlValue])] = []

    init(_ inner: ArmadaSqlDriver) {
        self.inner = inner
    }

    func run(_ sql: String, _ params: [SqlValue]) throws {
        statements.append(sql)
        try inner.run(sql, params)
    }

    func query<T>(_ sql: String, _ params: [SqlValue], _ read: (SqlRow) throws -> T) throws -> [T]
    {
        statements.append(sql)
        if sql.hasPrefix("SELECT") { selects.append((sql, params)) }
        return try inner.query(sql, params, read)
    }

    func close() {
        inner.close()
    }

    /// The `EXPLAIN QUERY PLAN` details of every SELECT `body` issued.
    func record(_ body: () throws -> Void) throws -> [String] {
        selects.removeAll()
        statements.removeAll()
        try body()

        var plans = [String]()
        for select in selects {
            plans.append(
                contentsOf: try inner.query(
                    "EXPLAIN QUERY PLAN \(select.sql)", select.params, { $0.text(3) }
                )
            )
        }
        return plans
    }

    /// The MATCH expression the last recorded scan bound, if any.
    func lastMatchExpression() -> String? {
        guard let select = selects.last(where: { $0.sql.contains("MATCH") }),
            case let .text(expression) = select.params.first
        else { return nil }
        return expression
    }
}
