import Foundation
import XCTest

@testable import ArmadaDB

/// The read path's serialization: a rumor rebuilt from stored columns writes
/// its own JSON rather than being re-derived through a serializer. A port of
/// `RumorJsonTest.kt`.
///
/// This is where the bridge's cost is — a query answered by building a
/// dictionary per row and stringifying the lot, on top of the pass the bridge
/// then makes to escape the payload into its response. The hand-written form is
/// only worth having if it is byte-for-byte a correct JSON encoder, so that is
/// what these assert: every escape JSON requires, the tags column spliced in
/// untouched, and the row-built form agreeing with the parsed form.
final class RumorJsonTests: XCTestCase {

    private func row(
        id: String = String(repeating: "a", count: 64),
        pubkey: String = String(repeating: "b", count: 64),
        createdAt: Int64 = 1_700_000_000,
        kind: Int = 1,
        tagsJson: String = #"[["e","aa"],["p","bb"]]"#,
        content: String = "hello"
    ) throws -> Rumor {
        try XCTUnwrap(
            Rumor.fromRow(
                id: id, kind: kind, pubkey: pubkey, createdAt: createdAt,
                tagsJson: tagsJson, content: content
            )
        )
    }

    /// The six NIP-01 fields, as a comparable form.
    private func fields(_ json: String) throws -> [String] {
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        let tags = try XCTUnwrap(object["tags"])
        let tagsText = String(
            decoding: try JSONSerialization.data(withJSONObject: tags), as: UTF8.self
        )
        return [
            try XCTUnwrap(object["id"] as? String),
            try XCTUnwrap(object["pubkey"] as? String),
            String(try XCTUnwrap(object["created_at"] as? NSNumber).int64Value),
            String(try XCTUnwrap(object["kind"] as? NSNumber).intValue),
            tagsText,
            try XCTUnwrap(object["content"] as? String),
        ]
    }

    private func content(of json: String) throws -> String {
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )
        return try XCTUnwrap(object["content"] as? String)
    }

    func testRowBuiltRumorSerializesToItsSixFields() throws {
        let json = try row().toJson()

        XCTAssertEqual(
            try fields(json),
            [
                String(repeating: "a", count: 64),
                String(repeating: "b", count: 64),
                "1700000000",
                "1",
                #"[["e","aa"],["p","bb"]]"#,
                "hello",
            ]
        )
    }

    func testRowBuiltFormAgreesWithTheParsedForm() throws {
        let tags = #"[["e","aa"],["p","bb"],["alt","a note"]]"#
        let built = try row(tagsJson: tags, content: "hi there")
        let parsed = try XCTUnwrap(
            Rumor.parse([
                "id": String(repeating: "a", count: 64),
                "pubkey": String(repeating: "b", count: 64),
                "created_at": 1_700_000_000,
                "kind": 1,
                "tags": try JSONSerialization.jsonObject(with: Data(tags.utf8)),
                "content": "hi there",
            ])
        )

        XCTAssertEqual(try fields(parsed.toJson()), try fields(built.toJson()))
        XCTAssertEqual(parsed.tags, built.tags)
    }

    func testContentEscapesSurviveARoundTrip() throws {
        let original = "quote \" backslash \\ slash / newline \n tab \t return \r "
            + "backspace \u{8} formfeed \u{C} nul \u{0} unit \u{1F} emoji 🚢 accent é"

        let json = try row(content: original).toJson()

        XCTAssertEqual(try content(of: json), original)
    }

    func testControlCharactersAreEscapedAsValidJson() throws {
        let json = try row(content: "\u{1}\u{1F}").toJson()

        XCTAssertTrue(json.contains(#"\u0001"#), json)
        XCTAssertTrue(json.contains(#"\u001f"#), json)
        XCTAssertEqual(try content(of: json), "\u{1}\u{1F}")
    }

    func testIdsAndKeysAreEscapedToo() throws {
        // Not hex, deliberately: nothing about the column type stops a caller
        // from having written something that needs quoting.
        let json = try row(id: "a\"b", pubkey: "c\\d").toJson()
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        )

        XCTAssertEqual(object["id"] as? String, "a\"b")
        XCTAssertEqual(object["pubkey"] as? String, "c\\d")
    }

    func testTagsColumnIsSplicedVerbatim() throws {
        // Whitespace inside the stored text survives, which is the proof it was
        // spliced rather than re-serialized.
        let json = try row(tagsJson: #"[["e", "aa"]]"#).toJson()

        XCTAssertTrue(json.contains(#"[["e", "aa"]]"#), json)
    }

    func testTagsParseLazilyFromTheStoredColumn() throws {
        let rumor = try row(tagsJson: #"[["e","aa"],["p","bb",1,null]]"#)

        XCTAssertEqual(rumor.tags, [["e", "aa"], ["p", "bb", nil, nil]])
        XCTAssertEqual(rumor.tagValue("e"), "aa")
        XCTAssertNil(rumor.tagValue("nope"))
    }

    func testEmptyTagsSerializeAsAnEmptyArray() throws {
        let rumor = try row(tagsJson: "[]")

        XCTAssertEqual(try fields(rumor.toJson())[4], "[]")
        XCTAssertEqual(rumor.tags, [])
    }

    func testARowWhoseTagsAreNotAnArrayIsRefused() {
        XCTAssertNil(
            Rumor.fromRow(id: "a", kind: 1, pubkey: "b", createdAt: 1, tagsJson: "{}", content: "c")
        )
        XCTAssertNil(
            Rumor.fromRow(id: "a", kind: 1, pubkey: "b", createdAt: 1, tagsJson: "", content: "c")
        )
        XCTAssertNil(
            Rumor.fromRow(
                id: "a", kind: 1, pubkey: "b", createdAt: 1, tagsJson: "null", content: "c"
            )
        )
    }

    func testAParsedRumorKeepsKeysBeyondTheSixAndDropsSig() throws {
        let parsed = try XCTUnwrap(
            Rumor.parse([
                "id": "a",
                "pubkey": "b",
                "created_at": 5,
                "kind": 1,
                "tags": [],
                "content": "c",
                "sig": String(repeating: "f", count: 128),
                "extra": "kept",
            ])
        )

        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(parsed.toJson().utf8)) as? [String: Any]
        )

        XCTAssertNil(object["sig"])
        XCTAssertEqual(object["extra"] as? String, "kept")
    }

    /// A rumor missing a field it cannot do without is not structurally one.
    func testAnUnstructuredObjectIsRefused() {
        XCTAssertNil(Rumor.parse(["pubkey": "b", "kind": 1]))
        XCTAssertNil(Rumor.parse(["id": "a", "kind": 1]))
        XCTAssertNil(Rumor.parse(["id": "a", "pubkey": "b"]))
        XCTAssertNil(Rumor.parse(["id": "", "pubkey": "b", "kind": 1]))
        XCTAssertNil(Rumor.parse(["id": "a", "pubkey": "b", "kind": -1]))
        XCTAssertNil(Rumor.parse(json: "not json"))
        XCTAssertNil(Rumor.parse(json: "[]"))
    }

    func testSizeHintCoversAnUnescapedRumor() throws {
        let rumor = try row(content: String(repeating: "a", count: 500))

        let hint = rumor.jsonSizeHint()
        let written = rumor.toJson().utf8.count
        XCTAssertGreaterThanOrEqual(hint, written, "hint \(hint) < written \(written)")
        // A hint far above the truth would waste the allocation it exists to save.
        XCTAssertLessThanOrEqual(hint, written + 64, "hint \(hint) vs written \(written)")
    }

    func testQuoteWritesABareStringWithNoEscapesNeeded() {
        var out = [UInt8]()

        JsonText.quote(&out, "plain ascii 123")

        XCTAssertEqual(String(decoding: out, as: UTF8.self), "\"plain ascii 123\"")
    }
}
