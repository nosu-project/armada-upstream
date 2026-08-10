import Foundation

/// A Nostr event or rumor, as far as this pipeline cares.
///
/// `id` and `sig` are optional because a rumor has no signature and may omit
/// its id — the openers compute the id themselves and refuse a claimed one that
/// disagrees, since an id is a display/dedup key and never something to trust.
struct NostrEvent {
    var id: String?
    var pubkey: String
    var createdAt: Int
    var kind: Int
    var tags: [[String]]
    var content: String
    var sig: String?

    /// Parse from a JSON object, or nil when any required field is missing or
    /// the wrong type.
    ///
    /// Tag entries must be strings throughout. A tag holding a number would
    /// still serialize in JavaScript, so accepting one here and coercing it
    /// would compute a DIFFERENT id than the sender did and silently reject a
    /// valid event; refusing outright at least fails for a legible reason. No
    /// Nostr event in practice carries one.
    static func parse(_ object: [String: Any]) -> NostrEvent? {
        guard let pubkey = object["pubkey"] as? String,
              let kind = object["kind"] as? Int,
              let content = object["content"] as? String,
              let rawTags = object["tags"] as? [Any]
        else { return nil }

        // `created_at` arrives as an NSNumber; take it as Int and refuse a
        // fractional value rather than truncating one into a different id.
        guard let createdAtNumber = object["created_at"] as? NSNumber else { return nil }
        let createdAtDouble = createdAtNumber.doubleValue
        guard createdAtDouble == createdAtDouble.rounded(),
              createdAtDouble >= 0,
              createdAtDouble <= Double(Int.max)
        else { return nil }
        let createdAt = Int(createdAtDouble)

        var tags = [[String]]()
        tags.reserveCapacity(rawTags.count)
        for rawTag in rawTags {
            guard let entries = rawTag as? [Any] else { return nil }
            var tag = [String]()
            tag.reserveCapacity(entries.count)
            for entry in entries {
                guard let value = entry as? String else { return nil }
                tag.append(value)
            }
            tags.append(tag)
        }

        return NostrEvent(
            id: object["id"] as? String,
            pubkey: pubkey,
            createdAt: createdAt,
            kind: kind,
            tags: tags,
            content: content,
            sig: object["sig"] as? String
        )
    }

    /// Parse from a JSON string.
    static func parse(json: String) -> NostrEvent? {
        guard let decoded = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let object = decoded as? [String: Any]
        else { return nil }
        return parse(object)
    }

    /// The canonical NIP-01 event id: `sha256` of
    /// `[0,pubkey,created_at,kind,tags,content]`, serialized byte-for-byte as
    /// JavaScript's `JSON.stringify` would (see `jsonString`). `JSONSerialization`
    /// must NOT be used here — it escapes forward slashes and orders nothing,
    /// which would change the hash.
    var computedId: String {
        var out = "[0,\""
        out += pubkey
        out += "\","
        out += String(createdAt)
        out += ","
        out += String(kind)
        out += ",["
        for (index, tag) in tags.enumerated() {
            if index > 0 { out += "," }
            out += "["
            for (entryIndex, entry) in tag.enumerated() {
                if entryIndex > 0 { out += "," }
                Self.jsonString(entry, into: &out)
            }
            out += "]"
        }
        out += "],"
        Self.jsonString(content, into: &out)
        out += "]"
        return Hex.encode(Crypto.sha256([UInt8](out.utf8)))
    }

    /// Append a JSON string literal exactly as JavaScript's `JSON.stringify`:
    /// escape `"` and `\`, the two-character forms for `\b \t \n \f \r`,
    /// `\u00xx` for other control characters, and everything else — including
    /// all non-ASCII — literally.
    ///
    /// The one case Swift cannot reproduce is a LONE SURROGATE, which
    /// `JSON.stringify` emits as `\udXXX`: a Swift `String` cannot hold one, so
    /// such an event's id can never be recomputed here and it simply fails to
    /// open. The same limitation applies throughout ArmadaDB's Swift port.
    private static func jsonString(_ value: String, into out: inout String) {
        out += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }

    /// The rumor as a JSON object, for handing to ArmadaDB.
    ///
    /// Deliberately the rumor's OWN fields and nothing else: no wrap id, no
    /// stream address, no seal form. Its tags are the bytes its id commits to,
    /// so anything added here would make the stored row something the sender
    /// never signed, and make whatever reads that tag forgeable by anyone who
    /// spells it (see AGENTS.md).
    func rumorJsonObject(id: String) -> [String: Any] {
        [
            "id": id,
            "pubkey": pubkey,
            "created_at": createdAt,
            "kind": kind,
            "tags": tags,
            "content": content,
        ]
    }

    // MARK: - Tags

    /// The one value of `name`, or nil when absent. Nil when REPEATED too: a
    /// binding that appears twice is ambiguous, and CORD-01 treats an ambiguous
    /// binding as no binding rather than picking the first.
    func uniqueTag(_ name: String) -> String? {
        var found: String?
        for tag in tags where tag.first == name {
            if found != nil { return nil }
            found = tag.count > 1 ? tag[1] : nil
        }
        return found
    }

    /// Whether any tag is `[name, value]`.
    func hasTag(_ name: String, value: String) -> Bool {
        tags.contains { $0.count > 1 && $0[0] == name && $0[1] == value }
    }

    /// The first value of `name`, or nil.
    func firstTag(_ name: String) -> String? {
        for tag in tags where tag.first == name && tag.count > 1 { return tag[1] }
        return nil
    }
}

// MARK: - NIP-40 expiration

enum Nip40 {
    /// The deadline (unix seconds) these tags carry, or nil when there is none.
    ///
    /// A malformed value is treated as ABSENT rather than as expired: a garbage
    /// tag must not be able to hide a message.
    static func expiration(_ tags: [[String]]) -> Int? {
        for tag in tags where tag.first == "expiration" && tag.count > 1 {
            guard let value = Double(tag[1]), value.isFinite else { return nil }
            return Int(value)
        }
        return nil
    }

    /// Whether these tags carry a deadline that has already passed.
    static func isExpired(_ tags: [[String]], now: Int) -> Bool {
        guard let at = expiration(tags) else { return false }
        return at <= now
    }
}
