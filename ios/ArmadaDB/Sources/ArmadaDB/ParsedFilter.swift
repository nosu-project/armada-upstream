import Foundation

/// A tag filter, e.g. `{ name: "channel", values: [...] }` for `#channel`.
struct TagFilter {
    /// The tag name without the leading `#` (single- or multi-letter).
    let name: String
    /// Sorted, de-duplicated set of acceptable values (drives the planner).
    let values: [String]
    let valueSet: Set<String>

    init(name: String, values: [String]) {
        self.name = name
        self.values = values
        self.valueSet = Set(values)
    }
}

/// The NIP-50 keywords a filter's `search` parsed to, pre-lowercased.
struct SearchKeywords {
    let required: [String]
    let negated: [String]
}

/// A parsed, normalized single Nostr filter plus an in-memory matcher. A port
/// of `src/lib/db/ParsedFilter.ts` by way of `ParsedFilter.kt`, itself from
/// Nostrify's `@nostrify/sqlite` and ultimately strfry's `NostrFilter`
/// (src/filters.h): it pre-sorts/dedupes each value set (which drives the
/// planner's selectivity choice) and matches a rumor against every condition at
/// once.
///
/// Matching semantics are NIP-01's:
///  - `ids`/`authors`/`kinds`: membership in the set.
///  - `#x` tag filters: the rumor has at least one `x` tag whose value is in
///    the set. The name may be single- or multi-letter (`#e`, `#channel`).
///  - `since`/`until`: inclusive created_at bounds.
///  - multiple filters in a query are OR'd; conditions within a filter AND.
struct ParsedFilter {

    let ids: [String]?
    let authors: [String]?
    let kinds: [Int]?
    let tags: [TagFilter]
    let search: String?

    /// The NIP-50 keywords parsed out of `search`. Extension tokens
    /// (`key:value`) are parsed and removed — none are supported, and per
    /// NIP-50 unsupported extensions are ignored. Nil when the filter has no
    /// `search`, or when it parses to no keywords (in which case it imposes no
    /// constraint).
    let searchKeywords: SearchKeywords?

    /// The same keywords as an FTS5 `MATCH` expression, or nil when they can't
    /// be expressed as one. FTS5 has no way to say "everything except X", so a
    /// search that is nothing but negations has no query; those fall back to
    /// matching in memory.
    let searchQuery: String?

    let since: Int64?
    let until: Int64?
    let limit: Int?

    /// True when this filter can never match anything (an empty array was given
    /// for a constraint, e.g. `{ ids: [] }`). The planner short-circuits these.
    let neverMatch: Bool

    private let idSet: Set<String>?
    private let authorSet: Set<String>?
    private let kindSet: Set<Int>?

    init(_ filter: [String: Any]) {
        var never = false
        var ids: [String]?
        var authors: [String]?
        var kinds: [Int]?
        var since: Int64?
        var until: Int64?
        var limit: Int?
        var search: String?
        var tags = [TagFilter]()

        // A constraint whose values all failed to decode — `{"kinds":["1"]}`, a
        // `#e` given a bare string — is an empty set, exactly like the literal
        // `[]` below, and means the same thing: nothing can match. Saying so is
        // also what keeps the planner honest, since it emits `Sql.memberOf` for
        // any non-nil list and `IN ()` is not valid SQL. The WebView coerces
        // instead, but both agree the filter is junk; failing closed is the
        // direction that can't answer a narrowing query with a whole tenant.
        func constraint<T>(_ decoded: [T]) -> [T]? {
            if decoded.isEmpty {
                never = true
                return nil
            }
            return decoded
        }

        for (key, value) in filter {
            // Empty array constraints can never match (NIP-01). Checked up
            // front so it covers the scalar keys too, which never reach
            // `constraint`.
            if let array = value as? [Any], array.isEmpty {
                never = true
                continue
            }

            switch key {
            case "ids":
                ids = constraint(Self.sortUnique(Self.strings(value)))
            case "authors":
                authors = constraint(Self.sortUnique(Self.strings(value)))
            case "kinds":
                kinds = constraint(Array(Set(Self.numbers(value))).sorted())
            case "since":
                since = Self.int64Value(value)
            case "until":
                until = Self.int64Value(value)
            case "limit":
                limit = Self.int64Value(value).map { Int($0) }
            case "search":
                search = value as? String
            default:
                // Any `#`-prefixed key is a tag filter; the name is everything
                // after the `#` (single- OR multi-letter). Whether such a tag is
                // actually queryable depends on the store's tag index policy — a
                // filter on a non-indexed tag simply matches nothing.
                // Unrecognized keys are ignored (treated as no constraint).
                guard key.hasPrefix("#"), key.count >= 2 else { continue }
                if let values = constraint(Self.sortUnique(Self.strings(value))) {
                    tags.append(TagFilter(name: String(key.dropFirst()), values: values))
                }
            }
        }

        self.ids = ids
        self.authors = authors
        self.kinds = kinds
        // Dictionary iteration has no defined order, so two filters differing
        // only in the order their `#x` keys were written would otherwise plan
        // to different SQL. Sorting makes the statement text — and so the
        // prepared-statement cache key — a function of the filter's content.
        self.tags = tags.sorted { codeUnitAscending($0.name, $1.name) }
        self.since = since
        self.until = until
        self.limit = limit
        self.search = search

        self.idSet = ids.map { Set($0) }
        self.authorSet = authors.map { Set($0) }
        self.kindSet = kinds.map { Set($0) }

        var keywords: SearchKeywords?
        var query: String?

        if let search {
            var required = [String]()
            var negated = [String]()

            for token in Nip50.parseInput(search) {
                guard case let .keyword(text) = token else { continue }  // extension: removed
                let keyword = text.lowercased()
                if keyword.hasPrefix("-") {
                    if keyword.count > 1 { negated.append(String(keyword.dropFirst())) }
                } else if !keyword.isEmpty {
                    required.append(keyword)
                }
            }

            if !required.isEmpty || !negated.isEmpty {
                keywords = SearchKeywords(required: required, negated: negated)
                query = Self.toFtsQuery(required: required, negated: negated)
            } else if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // The caller asked for something, and every part of it was
                // consumed by the parse: an extension nobody implements
                // (`domain:example.com`), or punctuation that tokenizes to
                // nothing (`""`). Falling through to "no keywords" would drop
                // the constraint ENTIRELY and hand back the whole tenant — the
                // opposite of what a narrowing query should do when it isn't
                // understood — so it fails closed instead.
                //
                // An empty or blank `search` is different: nothing was asked
                // for, so nothing is constrained, and the filter's other terms
                // stand alone.
                never = true
            }
        }

        self.searchKeywords = keywords
        self.searchQuery = query
        self.neverMatch = never
    }

    /// Full NIP-01 match of a rumor against every condition in this filter.
    ///
    /// Pass `skipSearch` when FTS5 has already applied the keywords.
    /// Re-checking them here would be worse than redundant: FTS5 matches whole
    /// words and this matches substrings, so a phrase FTS5 accepted could be
    /// rejected on whitespace alone.
    ///
    /// Pass `skipIds` when SQL has already applied the ids (`id IN (…)`, which
    /// compares bytes). Re-checking here compares the id read BACK from the
    /// row, and a driver that can't read every string back intact would then
    /// drop a row the store really holds.
    func matches(_ rumor: Rumor, skipSearch: Bool = false, skipIds: Bool = false) -> Bool {
        if neverMatch { return false }

        if let since, rumor.createdAt < since { return false }
        if let until, rumor.createdAt > until { return false }

        if !skipIds, let idSet, !idSet.contains(rumor.id) { return false }
        if let authorSet, !authorSet.contains(rumor.pubkey) { return false }
        if let kindSet, !kindSet.contains(rumor.kind) { return false }

        for tag in tags {
            let found = rumor.tags.contains { row in
                row.count >= 2 && row[0] == tag.name && row[1].map(tag.valueSet.contains) == true
            }
            if !found { return false }
        }

        if let searchKeywords, !skipSearch {
            let content = rumor.content.lowercased()
            for keyword in searchKeywords.required where !content.containsLiteral(keyword) {
                return false
            }
            for keyword in searchKeywords.negated where content.containsLiteral(keyword) {
                return false
            }
        }

        return true
    }

    // MARK: - decoding

    private static func strings(_ value: Any?) -> [String] {
        guard let array = value as? [Any] else { return [] }
        return array.compactMap { $0 as? String }
    }

    private static func numbers(_ value: Any?) -> [Int] {
        guard let array = value as? [Any] else { return [] }
        return array.compactMap { int64Value($0).map { Int($0) } }
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

    private static func sortUnique(_ values: [String]) -> [String] {
        Array(Set(values)).sorted(by: codeUnitAscending)
    }

    /// Build an FTS5 `MATCH` expression from NIP-50 keywords.
    ///
    /// Every keyword becomes a quoted phrase, which is FTS5's literal-string
    /// form, so nothing a user types is read as query syntax — a keyword of
    /// `OR` or `(` searches for that word rather than breaking the query.
    ///
    /// Returns nil when the keywords can't be put to FTS5 at all, which leaves
    /// them to the in-memory matcher:
    ///
    ///  - Only negations. FTS5 rejects an expression that is nothing but `NOT`,
    ///    since there's nothing to subtract them from.
    ///  - A keyword containing a NUL. FTS5's query parser is NUL-terminated, so
    ///    the rest of the expression — including the quote that closes the
    ///    phrase — is invisible to it, and the query dies with `unterminated
    ///    string` rather than returning anything. Stripping the NUL instead
    ///    would quietly search for something else.
    private static func toFtsQuery(required: [String], negated: [String]) -> String? {
        if required.isEmpty { return nil }
        if (required + negated).contains(where: { $0.unicodeScalars.contains("\u{0}") }) {
            return nil
        }

        let terms = required.map(phrase).joined(separator: " AND ")
        let exclusions = negated.map { "NOT \(phrase($0))" }
        return ([terms] + exclusions).joined(separator: " ")
    }

    private static func phrase(_ keyword: String) -> String {
        "\"\(keyword.replacingOccurrences(of: "\"", with: "\"\""))\""
    }
}

/// Order strings by their UTF-16 code units — JavaScript's `<` and Kotlin's
/// `String.compareTo`, which the other two ports sort and compare with.
///
/// Two things make this the right unit rather than Swift's own `<`. Swift
/// compares by Unicode canonical equivalence, so `é` and `e` + a combining
/// accent are EQUAL to it — two distinct keys a sort would then order
/// arbitrarily. And UTF-8 bytes, the obvious alternative, order astral
/// characters ABOVE U+E000…U+FFFF where UTF-16 puts them below, since surrogates
/// sort where surrogates sit. The store's `id ASC` tie-break and the KV range
/// bounds are both part of the contract the three ports share, so the ordering
/// has to be the one they share too.
func codeUnitAscending(_ lhs: String, _ rhs: String) -> Bool {
    lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
}

extension String {
    /// Substring containment by code units, not by canonical equivalence —
    /// `contains` on a Foundation-imported `String` would match `é` against
    /// `e` + combining accent, where the other two ports compare units.
    func containsLiteral(_ other: String) -> Bool {
        if other.isEmpty { return true }
        return range(of: other, options: .literal) != nil
    }
}

/// [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md) input
/// parsing.
enum Nip50 {

    /// A parsed token: a keyword, or an extension `key:value` (none of which
    /// Armada supports).
    enum Token {
        case keyword(String)
        case extensionToken(key: String, value: String)
    }

    /// `\w` is spelled out as ASCII rather than written `\w`, and the word
    /// boundaries as ASCII lookbehind rather than `\b`/`\B`: ICU reads both as
    /// Unicode-aware, where Java's and JavaScript's are ASCII — so the regex as
    /// written in the other two ports would tokenize `café:x` differently here.
    private static let pattern =
        #"(?<![A-Za-z0-9_])(-[A-Za-z0-9_]+:[^\s"]+)"#
        + #"|(?<![A-Za-z0-9_])([A-Za-z0-9_]+:[^\s"]+)"#
        + #"|(".*?")"#
        + #"|(\S+)"#

    private static let token = try! NSRegularExpression(pattern: pattern)

    /// Keywords and extension tokens, in order.
    static func parseInput(_ input: String) -> [Token] {
        let text = input as NSString
        let matches = token.matches(
            in: input, range: NSRange(location: 0, length: text.length)
        )

        var tokens = [Token]()
        for match in matches {
            let group = { (index: Int) -> String? in
                let range = match.range(at: index)
                return range.location == NSNotFound ? nil : text.substring(with: range)
            }

            if let ext = group(1) ?? group(2) {
                let parts = ext.components(separatedBy: ":")
                tokens.append(
                    .extensionToken(key: parts[0], value: parts.dropFirst().joined(separator: ":"))
                )
            } else if let quoted = group(3) {
                tokens.append(.keyword(quoted.replacingOccurrences(of: "\"", with: "")))
            } else if let bare = group(4) {
                tokens.append(.keyword(bare))
            }
        }

        return tokens
    }
}
