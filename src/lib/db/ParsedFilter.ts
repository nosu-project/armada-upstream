/**
 * A parsed, normalized Nostr filter plus in-memory matcher, ported from
 * `@nostrify/sqlite` (after strfry's src/filters.h). Value sets are sorted/deduped
 * for the planner. NIP-01 semantics; `#x` names may be multi-letter. NIP-50
 * extension tokens (`key:value`) are lookups in the DERIVED term index, and
 * `distinct:<namespace>` is a directive (see {@link ParsedFilter.distinct}).
 */
import { NIP50 } from "@nostrify/nostrify";

import { TERM_NAMESPACES_RESERVED, termNamespaceRange } from "./types";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/** A tag filter, e.g. `{ name: 'channel', values: [...] }` for `#channel`. */
export interface TagFilter {
  name: string;
  /** Sorted, de-duplicated set of acceptable values (drives the planner). */
  values: string[];
  valueSet: Set<string>;
}

export class ParsedFilter {
  readonly ids?: string[];
  readonly authors?: string[];
  readonly kinds?: number[];
  readonly tags: TagFilter[];
  readonly search?: string;

  /**
   * NIP-50 keywords, lowercased: all `required` must appear in content,
   * `negated` must not. `undefined` when there are none.
   */
  readonly searchKeywords?: { required: string[]; negated: string[] };

  /**
   * NIP-50 extension tokens as written, each required among the rumor's derived
   * terms ({@link TermPolicy}). Unsupported ones (`domain:`) thus FAIL CLOSED
   * rather than being ignored as NIP-50 allows relays to.
   */
  readonly terms: string[];

  /**
   * Term namespace from `distinct:<namespace>`: at most one rumor (the newest)
   * per term, with `limit` counting groups. Must happen INSIDE the read (as in
   * ditto-relay's `distinct:author`), since deduping a truncated page lets one
   * busy DM thread hide the rest. Every engine must agree:
   *  - Row conditions apply BEFORE the collapse.
   *  - Rumors with no term in the namespace are excluded.
   *  - Two `distinct:` tokens fail closed.
   */
  readonly distinct?: string;

  /** Keywords as an FTS5 `MATCH` expression; `undefined` if inexpressible (e.g. only negations). */
  readonly searchQuery?: string;

  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;

  private readonly idSet?: Set<string>;
  private readonly authorSet?: Set<string>;
  private readonly kindSet?: Set<number>;

  /** Can never match (an empty array constraint, e.g. `{ ids: [] }`). */
  readonly neverMatch: boolean;

  constructor(filter: NostrFilter) {
    let neverMatch = false;
    const tags: TagFilter[] = [];

    for (const [key, value] of Object.entries(filter)) {
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
        // Any `#` key is a tag filter; non-indexed tags simply match nothing.
        const values = sortUnique(value as string[]);
        tags.push({ name: key.slice(1), values, valueSet: new Set(values) });
      }
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
          // A reserved directive, read only here, never looked up as a term.
          if (token.key === "distinct") {
            distinctTokens++;
            distinct = token.value;
            continue;
          }
          if (TERM_NAMESPACES_RESERVED.includes(token.key)) continue;
          // Not lowercased: terms are opaque, case-significant strings.
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
        // Everything was consumed by the parse (unimplemented extension, or
        // punctuation): fail closed rather than return the whole tenant. A blank
        // `search` constrains nothing.
        neverMatch = true;
      }
    }

    this.terms = terms;

    // A collapse that can't be honoured exactly is refused, never approximated
    // (without it a conversation list would return every message).
    if (distinct !== undefined) {
      const range = termNamespaceRange(distinct);
      if (distinctTokens > 1 || !range) neverMatch = true;
      // Normalized (no trailing delimiter): `distinct:conv` == `distinct:conv:`.
      else this.distinct = range.lower.slice(0, -1);
    }

    this.neverMatch = neverMatch;
  }

  /**
   * The rumor's collapse group (its one term in the {@link distinct}
   * namespace), or `undefined` to exclude it.
   */
  collapseKey(derived: Iterable<string>): string | undefined {
    if (this.distinct === undefined) return undefined;
    const prefix = `${this.distinct}:`;
    for (const term of derived) if (term.startsWith(prefix)) return term;
    return undefined;
  }

  /**
   * Whether derived terms satisfy all of {@link terms}. Separate from
   * {@link matches} because terms come from the store's {@link TermPolicy}.
   */
  matchesTerms(derived: Iterable<string>): boolean {
    if (this.terms.length === 0) return true;
    const set = derived instanceof Set ? derived : new Set(derived);
    return this.terms.every((term) => set.has(term));
  }

  /**
   * Full NIP-01 match. {@link terms} and {@link distinct} are NOT checked
   * (row-wise use over-selects, the safe direction).
   *
   * `skipSearch` when FTS5 applied keywords (it matches words, this substrings).
   * `skipIds` when SQL applied ids: node:sqlite truncates NUL-containing TEXT
   * read back, which would drop real rows.
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
 * FTS5 `MATCH` expression from NIP-50 keywords, each a quoted phrase (quotes
 * doubled) so user input is never query syntax. `undefined` for only negations
 * (FTS5 rejects bare `NOT`) or a NUL (its parser is NUL-terminated).
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
