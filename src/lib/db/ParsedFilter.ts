/**
 * ParsedFilter — a parsed, normalized single Nostr filter plus an in-memory
 * matcher. Ported from Nostrify's `@nostrify/sqlite` (itself a port of
 * strfry's `NostrFilter`, src/filters.h): it pre-sorts/dedupes each value set
 * (which drives the planner's selectivity choice) and matches a rumor against
 * every condition at once.
 *
 * Matching semantics are NIP-01's:
 *   - `ids`/`authors`/`kinds`: membership in the set.
 *   - `#x` tag filters: the rumor has at least one `x` tag whose value is in
 *     the set. The name may be single- or multi-letter (`#e`, `#channel`).
 *   - `since`/`until`: inclusive created_at bounds.
 *   - multiple filters in a query are OR'd; conditions within a filter AND.
 *
 * One addition to those: a NIP-50 extension token (`key:value`) is a lookup in
 * the tenant's DERIVED term index rather than something read off the rumor —
 * see `terms` and `TermPolicy`. One token key is reserved as a DIRECTIVE instead:
 * `distinct:<namespace>` — see {@link ParsedFilter.distinct}.
 */
import { NIP50 } from "@nostrify/nostrify";

import { TERM_NAMESPACES_RESERVED, termNamespaceRange } from "./types";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** A tag filter, e.g. `{ name: 'channel', values: [...] }` for `#channel`. */
export interface TagFilter {
  /** The tag name without the leading `#` (single- or multi-letter). */
  name: string;
  /** Sorted, de-duplicated set of acceptable values (drives the planner). */
  values: string[];
  /** The same values as a Set, for O(1) membership in the matcher. */
  valueSet: Set<string>;
}

export class ParsedFilter {
  readonly ids?: string[];
  readonly authors?: string[];
  readonly kinds?: number[];
  /** Tag filters (`#x`), each holding a single- or multi-letter name. */
  readonly tags: TagFilter[];
  readonly search?: string;

  /**
   * The NIP-50 keywords parsed out of `search`, pre-lowercased: `required`
   * keywords must all appear in a rumor's content, `negated` ones (`-keyword`
   * tokens) must not. Extension tokens (`key:value`) are {@link terms} instead.
   * `undefined` when the filter has no `search`, or when it parses to no
   * keywords (in which case it imposes no constraint).
   */
  readonly searchKeywords?: { required: string[]; negated: string[] };

  /**
   * The NIP-50 extension tokens (`key:value`) named by `search`, spelled back
   * exactly as written. Every one of them must be among the rumor's derived
   * index terms — see {@link TermPolicy} — and the store resolves them against
   * that index rather than against anything the rumor says.
   *
   * A term no policy in this tenant emits therefore matches nothing, which is
   * how an unsupported extension (`domain:example.com`) still FAILS CLOSED: it
   * narrows to an empty index lookup rather than being dropped and answering a
   * narrowing query with the whole tenant. That is also why an extension is not
   * treated as an unsupported no-op the way NIP-50 allows a relay to treat it —
   * a local store answering its own queries has no one to negotiate with.
   */
  readonly terms: string[];

  /**
   * The term NAMESPACE this filter is collapsed by, from a `distinct:<namespace>`
   * token: the result holds at most one rumor per term in that namespace — the
   * newest, since a read is newest-first — and `limit` therefore counts groups
   * without ceasing to count rows.
   *
   * ditto-relay spells the same operation `distinct:author` over a field
   * (`src/opensearch.ts`), for the same reason it exists here: collapsing has to
   * happen INSIDE the read, because de-duplicating the answer afterwards can
   * only shrink an already-truncated page. That is precisely the NIP-17
   * conversation list, which sampled the newest 500 rumors and grouped them in
   * memory — so one busy thread hid every other conversation.
   *
   * The operand names a namespace, not a prefix, and the engines derive the
   * range from it ({@link termNamespaceRange}) — a prefix operand would make a
   * dropped delimiter ask for something subtly different rather than for
   * nothing. Semantics, which every engine must agree on:
   *
   *  - Row conditions apply BEFORE the collapse: the newest MATCHING rumor per
   *    group, so `kinds` and `authors` narrow the candidates rather than the
   *    survivors.
   *  - A rumor with no term in the namespace is excluded, not grouped under a
   *    null key — the same "no term, no match" a term lookup gives.
   *  - Two `distinct:` tokens can't be honoured (a term names one dimension, and
   *    the index cannot group by a pair), so they fail closed rather than pick
   *    one.
   *
   * `undefined` when the filter names no such token — which is every filter but
   * the conversation list's.
   */
  readonly distinct?: string;

  /**
   * The same keywords as an FTS5 `MATCH` expression, or `undefined` when they
   * can't be expressed as one. FTS5 has no way to say "everything except X",
   * so a search that is nothing but negations has no query; those fall back to
   * matching in memory.
   */
  readonly searchQuery?: string;

  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;

  /** Set views of the array constraints, for O(1) membership in `matches`. */
  private readonly idSet?: Set<string>;
  private readonly authorSet?: Set<string>;
  private readonly kindSet?: Set<number>;

  /**
   * True when this filter can never match anything (an empty array was given
   * for a constraint, e.g. `{ ids: [] }`). The planner short-circuits these.
   */
  readonly neverMatch: boolean;

  constructor(filter: NostrFilter) {
    let neverMatch = false;
    const tags: TagFilter[] = [];

    for (const [key, value] of Object.entries(filter)) {
      // Empty array constraints can never match (NIP-01).
      if (Array.isArray(value) && value.length === 0) {
        neverMatch = true;
        continue;
      }

      if (key === "ids") {
        this.ids = sortUnique(value as string[]);
      } else if (key === "authors") {
        this.authors = sortUnique(value as string[]);
      } else if (key === "kinds") {
        this.kinds = sortUniqueNums(value as number[]);
      } else if (key === "since") {
        this.since = value as number;
      } else if (key === "until") {
        this.until = value as number;
      } else if (key === "limit") {
        this.limit = value as number;
      } else if (key === "search") {
        this.search = value as string;
      } else if (key.startsWith("#") && key.length >= 2) {
        // Any `#`-prefixed key is a tag filter; the name is everything after
        // the `#` (single- OR multi-letter). Whether such a tag is actually
        // queryable depends on the store's `indexTags` policy — a filter on a
        // non-indexed tag simply matches nothing.
        const values = sortUnique(value as string[]);
        tags.push({ name: key.slice(1), values, valueSet: new Set(values) });
      }
      // Unrecognized keys are ignored (treated as no constraint).
    }

    this.tags = tags;

    this.idSet = this.ids && new Set(this.ids);
    this.authorSet = this.authors && new Set(this.authors);
    this.kindSet = this.kinds && new Set(this.kinds);

    const terms: string[] = [];
    let distinct: string | undefined;
    let distinctTokens = 0;

    if (this.search !== undefined) {
      const required: string[] = [];
      const negated: string[] = [];

      for (const token of NIP50.parseInput(this.search)) {
        if (typeof token !== "string") {
          // A reserved key is a DIRECTIVE to the store, not a term. It is read
          // here and nowhere else, so an engine that resolves terms in its index
          // never sees it as one to look up.
          if (token.key === "distinct") {
            distinctTokens++;
            distinct = token.value;
            continue;
          }
          if (TERM_NAMESPACES_RESERVED.includes(token.key)) continue;
          // An extension token is a lookup in the derived term index. It is
          // NOT lowercased: a term is an opaque string a policy returned, and
          // folding its case would make two distinct ones the same lookup.
          terms.push(`${token.key}:${token.value}`);
          continue;
        }
        const keyword = token.toLowerCase();
        if (keyword.startsWith("-")) {
          if (keyword.length > 1) negated.push(keyword.slice(1));
        } else if (keyword.length > 0) {
          required.push(keyword);
        }
      }

      if (required.length > 0 || negated.length > 0) {
        this.searchKeywords = { required, negated };
        this.searchQuery = toFtsQuery(required, negated);
      } else if (terms.length === 0 && distinct === undefined && this.search.trim() !== "") {
        // The caller asked for something, and every part of it was consumed by
        // the parse: an extension nobody implements (`domain:example.com`), or
        // punctuation that tokenizes to nothing (`""`). Falling through to "no
        // keywords" would drop the constraint ENTIRELY and hand back the whole
        // tenant — the opposite of what a narrowing query should do when it
        // isn't understood — so it fails closed instead.
        //
        // An empty or blank `search` is different: nothing was asked for, so
        // nothing is constrained, and the filter's other terms stand alone.
        neverMatch = true;
      }
    }

    this.terms = terms;

    // A collapse the store cannot honour exactly is refused, never approximated:
    // two dimensions it can't group by at once, or a namespace that isn't one
    // (empty, or itself containing the delimiter). Answering the filter WITHOUT
    // the collapse would return every row of a read the caller asked for one row
    // per group of — which for a conversation list is every message in the
    // store presented as a list of conversations.
    if (distinct !== undefined) {
      const range = termNamespaceRange(distinct);
      if (distinctTokens > 1 || !range) neverMatch = true;
      // Kept normalized (no trailing delimiter), so `distinct:conv` and
      // `distinct:conv:` are one namespace to everything downstream.
      else this.distinct = range.lower.slice(0, -1);
    }

    this.neverMatch = neverMatch;
  }

  /**
   * Which group a rumor with these derived terms collapses into — its one term
   * in the {@link distinct} namespace — or `undefined` when it has none and so
   * is excluded from a collapsed read.
   *
   * A policy derives at most one term per namespace (see {@link TermPolicy}), so
   * the first match is the answer; a policy that broke that rule would have its
   * rumor claim whichever group it was scanned under, which is also what an
   * index-side collapse does with it.
   */
  collapseKey(derived: Iterable<string>): string | undefined {
    if (this.distinct === undefined) return undefined;
    const prefix = `${this.distinct}:`;
    for (const term of derived) if (term.startsWith(prefix)) return term;
    return undefined;
  }

  /**
   * Whether a rumor whose derived terms are `derived` satisfies this filter's
   * {@link terms} — all of them, since conditions within a filter AND.
   *
   * Separate from {@link matches} because a term is not in the rumor: it comes
   * from the tenant's {@link TermPolicy}, which only the store holds. An engine
   * that resolved the terms in its index has already applied this; one that
   * couldn't re-derives the row's terms and calls it here.
   */
  matchesTerms(derived: Iterable<string>): boolean {
    if (this.terms.length === 0) return true;
    const set = derived instanceof Set ? derived : new Set(derived);
    return this.terms.every((term) => set.has(term));
  }

  /**
   * Full NIP-01 match of a rumor against every condition in this filter.
   *
   * {@link terms} are NOT checked — they aren't derivable from the rumor
   * alone; see {@link matchesTerms}. Neither is {@link distinct}, which is not a
   * property of a rumor at all: it selects between rumors that all match. A
   * caller applying this row-wise therefore OVER-selects a collapsed filter by
   * exactly the collapse, which is the safe direction — the read narrows it,
   * rather than a row escaping the filter.
   *
   * Pass `skipSearch` when FTS5 has already applied the keywords. Re-checking
   * them here would be worse than redundant: FTS5 matches whole words and this
   * matches substrings, so a phrase FTS5 accepted could be rejected on
   * whitespace alone.
   *
   * Pass `skipIds` when SQL has already applied the ids (`id IN (…)`, which
   * compares bytes). Re-checking here compares the id read BACK from the row,
   * and a driver that can't read a NUL-containing TEXT column intact
   * (node:sqlite truncates at the NUL) would then drop a row the store really
   * holds.
   */
  matches(rumor: NostrRumor, skipSearch = false, skipIds = false): boolean {
    if (this.neverMatch) return false;

    if (this.since !== undefined && rumor.created_at < this.since) return false;
    if (this.until !== undefined && rumor.created_at > this.until) return false;

    if (!skipIds && this.idSet && !this.idSet.has(rumor.id)) return false;
    if (this.authorSet && !this.authorSet.has(rumor.pubkey)) return false;
    if (this.kindSet && !this.kindSet.has(rumor.kind)) return false;

    for (const { name, valueSet } of this.tags) {
      const found = rumor.tags.some(([n, v]) => n === name && valueSet.has(v));
      if (!found) return false;
    }

    if (this.searchKeywords && !skipSearch) {
      const content = rumor.content.toLowerCase();
      for (const keyword of this.searchKeywords.required) {
        if (!content.includes(keyword)) return false;
      }
      for (const keyword of this.searchKeywords.negated) {
        if (content.includes(keyword)) return false;
      }
    }

    return true;
  }
}

/**
 * Build an FTS5 `MATCH` expression from NIP-50 keywords.
 *
 * Every keyword becomes a quoted phrase, which is FTS5's literal-string form,
 * so nothing a user types is read as query syntax — a keyword of `OR` or `(`
 * searches for that word rather than breaking the query. Embedded quotes are
 * doubled, per FTS5's escaping.
 *
 * Returns `undefined` when the keywords can't be put to FTS5 at all, which
 * leaves them to the in-memory matcher:
 *
 *  - Only negations. FTS5 rejects an expression that is nothing but `NOT`,
 *    since there's nothing to subtract them from.
 *  - A keyword containing a NUL. FTS5's query parser is NUL-terminated, so the
 *    rest of the expression — including the quote that closes the phrase — is
 *    invisible to it, and the query dies with `unterminated string` rather
 *    than returning anything. Stripping the NUL instead would quietly search
 *    for something else.
 */
function toFtsQuery(required: string[], negated: string[]): string | undefined {
  if (required.length === 0) return undefined;
  if ([...required, ...negated].some((keyword) => keyword.includes("\u0000"))) return undefined;

  const phrase = (keyword: string) => `"${keyword.replace(/"/g, '""')}"`;

  return [
    required.map(phrase).join(" AND "),
    ...negated.map((keyword) => `NOT ${phrase(keyword)}`),
  ].join(" ");
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sortUniqueNums(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
