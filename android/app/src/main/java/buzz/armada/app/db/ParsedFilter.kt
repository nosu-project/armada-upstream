package buzz.armada.app.db

import org.json.JSONArray
import org.json.JSONObject

/** A tag filter, e.g. `{ name: "channel", values: [...] }` for `#channel`. */
internal class TagFilter(
    /** The tag name without the leading `#` (single- or multi-letter). */
    val name: String,
    /** Sorted, de-duplicated set of acceptable values (drives the planner). */
    val values: List<String>,
) {
    val valueSet: Set<String> = values.toSet()
}

/** The NIP-50 keywords a filter's `search` parsed to, pre-lowercased. */
internal class SearchKeywords(val required: List<String>, val negated: List<String>)

/**
 * A parsed, normalized single Nostr filter plus an in-memory matcher. A port of
 * `src/lib/db/ParsedFilter.ts`, itself from Nostrify's `@nostrify/sqlite` and
 * ultimately strfry's `NostrFilter` (src/filters.h): it pre-sorts/dedupes each
 * value set (which drives the planner's selectivity choice) and matches a rumor
 * against every condition at once.
 *
 * Matching semantics are NIP-01's:
 *  - `ids`/`authors`/`kinds`: membership in the set.
 *  - `#x` tag filters: the rumor has at least one `x` tag whose value is in the
 *    set. The name may be single- or multi-letter (`#e`, `#channel`).
 *  - `since`/`until`: inclusive created_at bounds.
 *  - multiple filters in a query are OR'd; conditions within a filter AND.
 */
internal class ParsedFilter(filter: JSONObject) {

    val ids: List<String>?
    val authors: List<String>?
    val kinds: List<Int>?
    val tags: List<TagFilter>
    val search: String?

    /**
     * The NIP-50 keywords parsed out of `search`. Extension tokens
     * (`key:value`) are [terms] instead. Null when the filter has no `search`,
     * or when it parses to no keywords (in which case it imposes no constraint).
     */
    val searchKeywords: SearchKeywords?

    /**
     * The NIP-50 extension tokens (`key:value`) named by `search`, spelled back
     * exactly as written. Every one of them must be among the rumor's derived
     * index terms, which the store resolves against `rumor_terms` rather than
     * against anything the rumor says.
     *
     * A term no policy in this tenant emits therefore matches nothing, which is
     * how an unsupported extension (`domain:example.com`) still FAILS CLOSED:
     * it narrows to an empty index lookup rather than being dropped and
     * answering a narrowing query with the whole tenant.
     */
    val terms: List<String>

    /**
     * The term NAMESPACE this filter is collapsed by, from a
     * `distinct:<namespace>` token: the result holds at most one rumor per term
     * in that namespace — the newest, since a read is newest-first — and `limit`
     * therefore counts groups without ceasing to count rows.
     *
     * The port of `ParsedFilter.distinct` in TypeScript; every rule about it is
     * written down there. The two that shape this file: it is NOT a term (no
     * policy derives `distinct:…`, so a term lookup would match nothing), and a
     * collapse the store cannot honour EXACTLY fails closed rather than being
     * dropped — answering without it would return every row of a read that asked
     * for one row per group.
     */
    val distinct: String?

    /**
     * The same keywords as an FTS5 `MATCH` expression, or null when they can't
     * be expressed as one. FTS5 has no way to say "everything except X", so a
     * search that is nothing but negations has no query; those fall back to
     * matching in memory.
     */
    val searchQuery: String?

    val since: Long?
    val until: Long?
    val limit: Int?

    /**
     * True when this filter can never match anything (an empty array was given
     * for a constraint, e.g. `{ ids: [] }`). The planner short-circuits these.
     */
    val neverMatch: Boolean

    private val idSet: Set<String>?
    private val authorSet: Set<String>?
    private val kindSet: Set<Int>?

    init {
        var never = false
        var ids: List<String>? = null
        var authors: List<String>? = null
        var kinds: List<Int>? = null
        var since: Long? = null
        var until: Long? = null
        var limit: Int? = null
        var search: String? = null
        val tags = ArrayList<TagFilter>()

        // A constraint whose values all failed to decode — `{"kinds":["1"]}`, a
        // `#e` given a bare string — is an empty set, exactly like the literal
        // `[]` below, and means the same thing: nothing can match. Saying so is
        // also what keeps the planner honest, since it emits `Sql.memberOf` for
        // any non-null list and `IN ()` is not valid SQL. The WebView coerces
        // instead, but both agree the filter is junk; failing closed is the
        // direction that can't answer a narrowing query with a whole tenant.
        fun <T> constraint(decoded: List<T>): List<T>? {
            if (decoded.isEmpty()) {
                never = true
                return null
            }
            return decoded
        }

        val keys = filter.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val value = filter.opt(key)

            // Empty array constraints can never match (NIP-01). Checked up
            // front so it covers the scalar keys too, which never reach
            // `constraint`.
            if (value is JSONArray && value.length() == 0) {
                never = true
                continue
            }

            when {
                key == "ids" -> ids = constraint(sortUnique(strings(value)))
                key == "authors" -> authors = constraint(sortUnique(strings(value)))
                key == "kinds" -> kinds = constraint(numbers(value).distinct().sorted())
                key == "since" -> since = optLong(value)
                key == "until" -> until = optLong(value)
                key == "limit" -> limit = optLong(value)?.toInt()
                key == "search" -> search = value as? String
                key.startsWith("#") && key.length >= 2 -> {
                    // Any `#`-prefixed key is a tag filter; the name is
                    // everything after the `#` (single- OR multi-letter).
                    // Whether such a tag is actually queryable depends on the
                    // store's tag index policy — a filter on a non-indexed tag
                    // simply matches nothing.
                    val values = constraint(sortUnique(strings(value)))
                    if (values != null) tags.add(TagFilter(key.substring(1), values))
                }
                // Unrecognized keys are ignored (treated as no constraint).
            }
        }

        this.ids = ids
        this.authors = authors
        this.kinds = kinds
        this.tags = tags
        this.since = since
        this.until = until
        this.limit = limit
        this.search = search

        this.idSet = ids?.toSet()
        this.authorSet = authors?.toSet()
        this.kindSet = kinds?.toSet()

        var keywords: SearchKeywords? = null
        var query: String? = null
        val terms = ArrayList<String>()
        var collapse: String? = null
        var collapseTokens = 0

        if (search != null) {
            val required = ArrayList<String>()
            val negated = ArrayList<String>()

            for (token in Nip50.parseInput(search)) {
                if (token !is String) {
                    val extension = token as Nip50.Extension
                    // A reserved key is a DIRECTIVE to the store, not a term. It
                    // is read here and nowhere else, so an engine resolving terms
                    // in its index never sees it as one to look up.
                    if (extension.key == DISTINCT) {
                        collapseTokens++
                        collapse = extension.value
                        continue
                    }
                    if (extension.key in RESERVED_NAMESPACES) continue
                    // An extension token is a lookup in the derived term index.
                    // NOT lowercased: a term is an opaque string a policy
                    // returned, and folding its case would make two distinct
                    // ones the same lookup.
                    terms.add("${extension.key}:${extension.value}")
                    continue
                }
                val keyword = token.lowercase()
                if (keyword.startsWith("-")) {
                    if (keyword.length > 1) negated.add(keyword.substring(1))
                } else if (keyword.isNotEmpty()) {
                    required.add(keyword)
                }
            }

            if (required.isNotEmpty() || negated.isNotEmpty()) {
                keywords = SearchKeywords(required, negated)
                query = toFtsQuery(required, negated)
            } else if (terms.isEmpty() && collapse == null && search.isNotBlank()) {
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

        this.searchKeywords = keywords
        this.searchQuery = query
        this.terms = terms

        // A collapse the store cannot honour exactly is refused, never
        // approximated: two dimensions it cannot group by at once, or a namespace
        // that isn't one (empty, or itself containing the delimiter).
        var namespace: String? = null
        if (collapse != null) {
            val range = TermRange.of(collapse)
            if (collapseTokens > 1 || range == null) never = true else namespace = range.namespace
        }
        this.distinct = namespace
        this.neverMatch = never
    }

    /**
     * Which group a rumor with these derived terms collapses into — its one term
     * in the [distinct] namespace — or null when it has none and so is excluded
     * from a collapsed read.
     */
    fun collapseKey(derived: List<String>): String? {
        val namespace = distinct ?: return null
        val prefix = "$namespace:"
        return derived.firstOrNull { it.startsWith(prefix) }
    }

    /**
     * Full NIP-01 match of a rumor against every condition in this filter.
     *
     * Pass [skipSearch] when FTS5 has already applied the keywords. Re-checking
     * them here would be worse than redundant: FTS5 matches whole words and this
     * matches substrings, so a phrase FTS5 accepted could be rejected on
     * whitespace alone.
     *
     * Pass [skipIds] when SQL has already applied the ids (`id IN (…)`, which
     * compares bytes). Re-checking here compares the id read BACK from the row,
     * and a driver that can't read every string back intact would then drop a
     * row the store really holds.
     */
    fun matches(rumor: Rumor, skipSearch: Boolean = false, skipIds: Boolean = false): Boolean {
        if (neverMatch) return false

        if (since != null && rumor.createdAt < since) return false
        if (until != null && rumor.createdAt > until) return false

        if (!skipIds && idSet != null && rumor.id !in idSet) return false
        if (authorSet != null && rumor.pubkey !in authorSet) return false
        if (kindSet != null && rumor.kind !in kindSet) return false

        for (tag in tags) {
            val found = rumor.tags.any { row ->
                row.size >= 2 && row[0] == tag.name && row[1] != null && row[1] in tag.valueSet
            }
            if (!found) return false
        }

        val keywords = searchKeywords
        if (keywords != null && !skipSearch) {
            val content = rumor.content.lowercase()
            for (keyword in keywords.required) if (!content.contains(keyword)) return false
            for (keyword in keywords.negated) if (content.contains(keyword)) return false
        }

        return true
    }

    private companion object {
        fun strings(value: Any?): List<String> {
            val array = value as? JSONArray ?: return emptyList()
            val out = ArrayList<String>(array.length())
            for (i in 0 until array.length()) {
                val item = array.opt(i)
                if (item is String) out.add(item)
            }
            return out
        }

        fun numbers(value: Any?): List<Int> {
            val array = value as? JSONArray ?: return emptyList()
            val out = ArrayList<Int>(array.length())
            for (i in 0 until array.length()) {
                val item = array.opt(i)
                if (item is Number) out.add(item.toInt())
            }
            return out
        }

        fun optLong(value: Any?): Long? = (value as? Number)?.toLong()

        fun sortUnique(values: List<String>): List<String> = values.distinct().sorted()

        /**
         * Build an FTS5 `MATCH` expression from NIP-50 keywords.
         *
         * Every keyword becomes a quoted phrase, which is FTS5's literal-string
         * form, so nothing a user types is read as query syntax — a keyword of
         * `OR` or `(` searches for that word rather than breaking the query.
         *
         * Returns null when the keywords can't be put to FTS5 at all, which
         * leaves them to the in-memory matcher:
         *
         *  - Only negations. FTS5 rejects an expression that is nothing but
         *    `NOT`, since there's nothing to subtract them from.
         *  - A keyword containing a NUL. FTS5's query parser is NUL-terminated,
         *    so the rest of the expression — including the quote that closes the
         *    phrase — is invisible to it, and the query dies with `unterminated
         *    string` rather than returning anything. Stripping the NUL instead
         *    would quietly search for something else.
         */
        fun toFtsQuery(required: List<String>, negated: List<String>): String? {
            if (required.isEmpty()) return null
            if ((required + negated).any { it.contains('\u0000') }) return null

            val terms = required.joinToString(" AND ") { phrase(it) }
            val exclusions = negated.map { "NOT ${phrase(it)}" }
            return (listOf(terms) + exclusions).joinToString(" ")
        }

        fun phrase(keyword: String): String = "\"${keyword.replace("\"", "\"\"")}\""
    }
}

/**
 * The extension-token key that is a DIRECTIVE to the store rather than a term:
 * `distinct:<namespace>` collapses a read to one rumor per term in that
 * namespace. A policy must never derive a term under it — see `TermPolicy` in
 * `src/lib/db/types.ts`.
 */
internal const val DISTINCT = "distinct"

/**
 * Every such key, the counterpart of `TERM_NAMESPACES_RESERVED` in
 * `src/lib/db/types.ts` — one today, and a set rather than a comparison so that
 * a second one is a line in each port rather than a silent disagreement about
 * what an unrecognized directive means. A reserved key is CONSUMED here: filing
 * it as a term instead would fail closed (nothing matches) where the TypeScript
 * side drops it, so the two would narrow in opposite directions.
 */
internal val RESERVED_NAMESPACES = setOf(DISTINCT)

/**
 * The half-open term range a namespace covers: every term of the form
 * `<namespace>:<anything>`. The port of `termNamespaceRange`.
 *
 * Derived from the namespace rather than taken as a prefix, so a prefix SPANNING
 * namespaces cannot be spelled — `distinct:conv` collapsing groups from `conv:`,
 * `convmsg:` and `convmine:` at once would be a silently wrong answer, and a
 * missing delimiter would be enough to ask for it. A trailing delimiter is
 * tolerated, so `conv` and `conv:` name the same range.
 *
 * Splitting a term on its first colon is the only interpreting of a term this
 * engine does, and it is the delimiter the read path already required: a term is
 * named in a filter as a NIP-50 token, which is reassembled as `key:value`.
 */
internal class TermRange private constructor(
    /** The namespace, with no trailing delimiter. */
    val namespace: String,
    /** Inclusive lower bound: `<namespace>:`. */
    val lower: String,
    /** Exclusive upper bound, or null when the prefix has none. */
    val upper: String?,
) {
    companion object {
        fun of(namespace: String): TermRange? {
            val name = namespace.removeSuffix(":")
            if (name.isEmpty() || name.contains(":")) return null
            val lower = "$name:"
            return TermRange(name, lower, upperBound(lower))
        }

        /**
         * The exclusive upper bound of the keys starting with [prefix], or null
         * when there isn't one — a prefix ending in the maximal UTF-16 code unit
         * is open-ended.
         */
        private fun upperBound(prefix: String): String? {
            val last = prefix.last()
            if (last.code == 0xFFFF) return null
            return prefix.dropLast(1) + (last + 1)
        }
    }
}

/** [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md) input parsing. */
internal object Nip50 {

    private val TOKEN = Regex("""(\B-\w+:[^\s"]+)|(\b\w+:[^\s"]+)|(".*?")|(\S+)""")

    /**
     * An extension token: `key:value`. Armada resolves these against the
     * tenant's derived term index — see [ParsedFilter.terms].
     */
    class Extension(val key: String, val value: String)

    /** Keywords (as [String]) and extension tokens (as [Extension]), in order. */
    fun parseInput(input: String): List<Any> {
        val tokens = ArrayList<Any>()

        for (match in TOKEN.findAll(input)) {
            val extension = match.groups[1]?.value ?: match.groups[2]?.value
            val quoted = match.groups[3]?.value
            val bare = match.groups[4]?.value

            when {
                extension != null -> {
                    val parts = extension.split(":")
                    tokens.add(Extension(parts[0], parts.drop(1).joinToString(":")))
                }
                quoted != null -> tokens.add(quoted.replace("\"", ""))
                bare != null -> tokens.add(bare)
            }
        }

        return tokens
    }
}
