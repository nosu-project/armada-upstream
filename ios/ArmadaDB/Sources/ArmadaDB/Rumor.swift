import Foundation

/// A stored event: everything ArmadaDB holds is *already authenticated* by the
/// time it lands (a signature check, or gift-wrap decryption which
/// authenticates by construction), so the store deals in signature-less rumors
/// and never carries a `sig` it would have to lie about. A port of `Rumor.kt`.
///
/// A rumor arrives one of two ways, and the difference is the whole performance
/// story of the read path:
///
///  - `parse` takes JSON a caller handed over. That object IS the rumor's form
///    — it may carry keys beyond the six NIP-01 fields, so it is kept and
///    re-emitted verbatim.
///  - `fromRow` rebuilds one from the six columns the store persists. Here the
///    tags are ALREADY JSON array text, straight out of SQLite, and the other
///    five fields are scalars — so the rumor's JSON can be *written* rather
///    than re-derived, splicing the tags column in untouched.
///
/// Which is why the parsed forms are lazy. A query answers with rumors that are
/// almost always only serialized back out again (`appendJson`); parsing every
/// tag array into `[[String?]]`, only to stringify the lot again, was several
/// passes over data that needed none. Rows that ARE inspected — the post-SQL
/// filter check, the relay-scope rule, NIP-40 expiry — pay for the parse on
/// first touch, once.
///
/// Not thread-safe, deliberately: the caches below are plain stored properties.
/// A rumor never outlives the call that produced it, and the driver serializes
/// those, so a lock here would be paid for on every read and used by nobody.
public final class Rumor {

    public let id: String
    public let pubkey: String
    public let createdAt: Int64
    public let kind: Int
    public let content: String

    /// The JSON this rumor was parsed from (minus any `sig`), or nil when it
    /// was rebuilt from stored columns and its JSON is therefore derivable.
    private let source: [String: Any]?

    /// The `tags` column: tag rows as JSON array text. Nil when only `source`
    /// is known.
    private let storedTags: String?

    private var cachedTags: [[String?]]?

    private init(
        id: String,
        pubkey: String,
        createdAt: Int64,
        kind: Int,
        content: String,
        source: [String: Any]?,
        storedTags: String?
    ) {
        self.id = id
        self.pubkey = pubkey
        self.createdAt = createdAt
        self.kind = kind
        self.content = content
        self.source = source
        self.storedTags = storedTags
    }

    /// Tag rows. An entry that wasn't a JSON string is nil: NIP-01 filters and
    /// the tag index both compare against strings, so a nil can never match,
    /// which is what the WebView's `typeof value !== "string"` guards achieve.
    public var tags: [[String?]] {
        if let cachedTags { return cachedTags }
        let rows = Self.tagRows(tagsArray())
        cachedTags = rows
        return rows
    }

    /// The stored form: the rumor's JSON, without a signature.
    public func toJson() -> String {
        var out = [UInt8]()
        out.reserveCapacity(jsonSizeHint())
        appendJson(to: &out)
        return String(decoding: out, as: UTF8.self)
    }

    /// The rumor as a JSON object, for a caller that needs to look inside it.
    public func toJsonObject() -> [String: Any] {
        source ?? rebuiltBody()
    }

    /// Append this rumor's JSON to `out`.
    ///
    /// The point of the class: for a row-built rumor nothing is parsed and
    /// nothing is re-derived — five scalars are written and the `tags` column
    /// is spliced in as the JSON array text it already is.
    public func appendJson(to out: inout [UInt8]) {
        if let source {
            if let data = try? JSONSerialization.data(withJSONObject: source) {
                out.append(contentsOf: data)
                return
            }
        }
        out.append(contentsOf: Array(#"{"id":"#.utf8))
        JsonText.quote(&out, id)
        out.append(contentsOf: Array(#","pubkey":"#.utf8))
        JsonText.quote(&out, pubkey)
        out.append(contentsOf: Array(#","created_at":"#.utf8))
        out.append(contentsOf: Array(String(createdAt).utf8))
        out.append(contentsOf: Array(#","kind":"#.utf8))
        out.append(contentsOf: Array(String(kind).utf8))
        out.append(contentsOf: Array(#","tags":"#.utf8))
        out.append(contentsOf: Array((storedTags ?? "[]").utf8))
        out.append(contentsOf: Array(#","content":"#.utf8))
        JsonText.quote(&out, content)
        out.append(UInt8(ascii: "}"))
    }

    /// How many bytes `appendJson` will write, to presize a buffer.
    ///
    /// Exact for a rumor whose strings need no escaping, which is the ordinary
    /// case (hex ids, plain text); content full of quotes or control characters
    /// writes more and costs one resize, which is the cheap direction to be
    /// wrong in.
    func jsonSizeHint() -> Int {
        Self.jsonOverhead + id.utf8.count + pubkey.utf8.count + content.utf8.count
            + (storedTags?.utf8.count ?? 2)
    }

    /// The tag rows as JSON array text — the stored column form.
    public func tagsJson() -> String {
        if let storedTags { return storedTags }
        guard let array = source?["tags"] as? [Any],
            let data = try? JSONSerialization.data(withJSONObject: array)
        else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }

    /// The first value of the first tag named `name`, or nil.
    public func tagValue(_ name: String) -> String? {
        for tag in tags where tag.count >= 2 && tag[0] == name {
            return tag[1]
        }
        return nil
    }

    /// The six-field body, rebuilt from the columns. Only a `toJsonObject`
    /// caller needs it.
    private func rebuiltBody() -> [String: Any] {
        [
            "id": id,
            "pubkey": pubkey,
            "created_at": createdAt,
            "kind": kind,
            "tags": tagsArray() ?? [],
            "content": content,
        ]
    }

    private func tagsArray() -> [Any]? {
        if let fromSource = source?["tags"] as? [Any] { return fromSource }
        guard let storedTags,
            let parsed = try? JSONSerialization.jsonObject(with: Data(storedTags.utf8))
        else { return nil }
        return parsed as? [Any]
    }

    /// The six-field form minus the field values: 64 bytes of keys, quotes,
    /// commas and braces, plus room for `created_at` (up to 20 digits) and
    /// `kind` (up to 11).
    private static let jsonOverhead = 64 + 20 + 11

    // MARK: - construction

    /// Parse a rumor, or nil if it isn't structurally one.
    public static func parse(json: String) -> Rumor? {
        guard let decoded = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
            let object = decoded as? [String: Any]
        else { return nil }
        return parse(object)
    }

    /// Parse a rumor from an already-decoded object. A `sig` is stripped rather
    /// than rejected: a caller can hand over a full signed event structurally,
    /// and persisting the signature would make this store disagree with every
    /// other adapter about what it holds.
    public static func parse(_ source: [String: Any]) -> Rumor? {
        guard let id = source["id"] as? String, !id.isEmpty,
            let pubkey = source["pubkey"] as? String, !pubkey.isEmpty,
            let kind = intValue(source["kind"]), kind >= 0
        else { return nil }

        return Rumor(
            id: id,
            pubkey: pubkey,
            createdAt: int64Value(source["created_at"]) ?? 0,
            kind: Int(kind),
            content: source["content"] as? String ?? "",
            source: copyWithoutSignature(source),
            storedTags: nil
        )
    }

    /// Build a rumor from its parts, for a caller writing one of its own (an
    /// opened Concord rumor, a parked wrap). Tag rows are copied verbatim, so
    /// provenance the caller folds in rides along.
    public static func of(
        id: String,
        pubkey: String,
        createdAt: Int64,
        kind: Int,
        tags: [[String]],
        content: String
    ) -> Rumor? {
        parse([
            "id": id,
            "pubkey": pubkey,
            "created_at": createdAt,
            "kind": kind,
            "tags": tags,
            "content": content,
        ])
    }

    /// Reassemble a rumor from its stored columns. The store persists only the
    /// six NIP-01 fields, so the body is derivable from them and the tags text
    /// is kept as the column form it already is.
    ///
    /// `tagsJson` is checked for its brackets rather than parsed: every row was
    /// written by `insertRumor` from `tagsJson()` of a parsed rumor, so the text
    /// is a JSON array by construction, and parsing several thousand of them to
    /// re-confirm that is the cost this class exists to avoid. A row corrupt
    /// enough to fail the full parse still fails — at the point something
    /// actually reads `tags`.
    public static func fromRow(
        id: String,
        kind: Int,
        pubkey: String,
        createdAt: Int64,
        tagsJson: String,
        content: String
    ) -> Rumor? {
        guard !id.isEmpty, !pubkey.isEmpty, kind >= 0 else { return nil }
        let tags = tagsJson.trimmingCharacters(in: .whitespacesAndNewlines)
        guard tags.hasPrefix("["), tags.hasSuffix("]") else { return nil }

        return Rumor(
            id: id,
            pubkey: pubkey,
            createdAt: createdAt,
            kind: kind,
            content: content,
            source: nil,
            storedTags: tags
        )
    }

    private static func tagRows(_ tags: [Any]?) -> [[String?]] {
        guard let tags else { return [] }
        var rows = [[String?]]()
        rows.reserveCapacity(tags.count)
        for entry in tags {
            guard let tag = entry as? [Any] else { continue }
            rows.append(tag.map { $0 as? String })
        }
        return rows
    }

    private static func copyWithoutSignature(_ source: [String: Any]) -> [String: Any] {
        guard source["sig"] != nil else { return source }
        var copy = source
        copy.removeValue(forKey: "sig")
        return copy
    }

    /// JSON numbers arrive as `NSNumber` on Darwin and as a few different
    /// concrete types on Linux, so a rumor's `kind` and `created_at` are read
    /// through these rather than through a single cast that happens to work on
    /// one platform.
    private static func intValue(_ value: Any?) -> Int? {
        int64Value(value).map { Int($0) }
    }

    private static func int64Value(_ value: Any?) -> Int64? {
        switch value {
        case let number as Int64: return number
        case let number as Int: return Int64(number)
        case let number as NSNumber: return number.int64Value
        case let number as Double: return Int64(number)
        default: return nil
        }
    }
}

extension Rumor: CustomStringConvertible {
    public var description: String {
        "Rumor(\(id.prefix(8)), kind=\(kind))"
    }
}

/// Writing JSON text straight into a byte buffer.
///
/// `JSONSerialization` is the wrong shape for a page of rumors: it walks a
/// dictionary the store has no reason to build in the first place, on top of
/// the pass the bridge then makes to escape the finished string into its
/// response envelope. Here a string is scanned for the characters JSON actually
/// requires escaping and copied in runs, which for rumor content (hex ids,
/// ordinary text) is one bulk copy of its UTF-8.
enum JsonText {

    private static let hex = Array("0123456789abcdef".utf8)

    /// Append `value` to `out` as a quoted, escaped JSON string.
    static func quote(_ out: inout [UInt8], _ value: String) {
        out.append(UInt8(ascii: "\""))

        let utf8 = Array(value.utf8)
        var start = 0
        for index in utf8.indices {
            let byte = utf8[index]
            // Every byte of a multi-byte UTF-8 sequence is ≥ 0x80, so scanning
            // bytes never splits a character: only ASCII can match here.
            let escape: [UInt8]?
            switch byte {
            case UInt8(ascii: "\""): escape = Array("\\\"".utf8)
            case UInt8(ascii: "\\"): escape = Array("\\\\".utf8)
            case 0x0A: escape = Array("\\n".utf8)
            case 0x0D: escape = Array("\\r".utf8)
            case 0x09: escape = Array("\\t".utf8)
            case 0x08: escape = Array("\\b".utf8)
            case 0x0C: escape = Array("\\u000c".utf8)
            case 0x00...0x1F: escape = nil
            default: continue
            }

            if index > start { out.append(contentsOf: utf8[start..<index]) }
            if let escape {
                out.append(contentsOf: escape)
            } else {
                out.append(contentsOf: Array("\\u00".utf8))
                out.append(hex[Int(byte >> 4) & 0xF])
                out.append(hex[Int(byte) & 0xF])
            }
            start = index + 1
        }
        if start < utf8.count { out.append(contentsOf: utf8[start...]) }

        out.append(UInt8(ascii: "\""))
    }
}

/// Kind ranges, per NIP-01.
enum Kinds {
    static func ephemeral(_ kind: Int) -> Bool { (20000...29999).contains(kind) }
    static func replaceable(_ kind: Int) -> Bool {
        kind == 0 || kind == 3 || (10000...19999).contains(kind)
    }
    static func addressable(_ kind: Int) -> Bool { (30000...39999).contains(kind) }
}
