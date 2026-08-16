/**
 * ArmadaDB — the shape all Armada client data is meant to converge on, with
 * one adapter per platform storage engine (IndexedDB everywhere today, SQLite
 * once a driver exists for it — see `armadaDB.ts`).
 *
 * Two ideas carry the whole surface:
 *
 *  - **Tenants.** A tenant is an isolated event namespace addressed by an
 *    opaque string id, e.g. `c2:${concordId}` for a Concord community,
 *    `dm17:${pubkey}` for a DM inbox, `nip29:${relayUrl}` for one relay's
 *    NIP-29 data, `main` for the global event cache. Ids never collide across
 *    tenants: the same rumor id can be stored in two tenants independently, and
 *    a query in one never sees the other — which is how two servers' channels
 *    are kept apart when they share a group id or even a signing key (see
 *    `relayScope.ts`).
 *  - **Rumors, not events.** Everything Armada stores locally is *already
 *    authenticated* by the time it lands (a signature check, or gift-wrap
 *    decryption which authenticates by construction), so the store deals in
 *    signature-less rumors and never carries a `sig` it would have to lie
 *    about.
 *
 * A stored rumor is normally the one its author wrote, byte for byte, so `id`
 * is the NIP-01 hash of the row's own contents. Nothing here enforces that —
 * `id` is just the key — and two callers deliberately use it otherwise, both
 * because the row's identity is a DEDUP key rather than a content hash:
 *
 *  - the invite inbox (`inviteInbox.ts`) keys by the WRAP id, since the inbox
 *    dedups on wraps and two wraps can carry the same invite;
 *  - the parked-wrap tenant (`c2park`) stores wraps, whose id is their own.
 *
 * Anything else that stores a rumor stores it verbatim, and the reasons are in
 * `concord/lib/rumorStore.ts` and `nip17/dm17Store.ts`: a rumor's tags are
 * the bytes its id commits to, so bookkeeping written into them makes the row
 * something the sender never signed.
 */
import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * `NStore`, but for rumors. Same NIP-01 filter semantics; the stored events
 * have no `sig`.
 */
export interface NRumorStore {
  /**
   * Rumors matching any of the filters, newest first (ties: smaller id first).
   *
   * NIP-50 `search` is the one place the adapters don't agree exactly:
   *
   *  - SQLite resolves it against an FTS5 index, so keywords match whole
   *    **words** (case- and accent-insensitively), while IndexedDB scans
   *    content for **substrings**. `brown` finds "the quick brown fox" on
   *    both; `brow` finds it only on IndexedDB.
   *  - SQLite parses the input per NIP-50 — several keywords all have to
   *    match, `-keyword` excludes, and `key:value` extensions are ignored as
   *    unsupported — while IndexedDB (via `NIndexedDB`) tests the raw string
   *    as one substring. So `red -anchor` finds "red boat" only on SQLite.
   *
   * They do agree on failing CLOSED: a non-empty search that names nothing
   * either can match (`domain:example.com`, `""`) matches nothing, rather than
   * dropping the constraint and answering a narrowing query with everything.
   * An absent or blank `search` asked for nothing and constrains nothing.
   */
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
  /** Store one rumor. Resolves once the write has committed. */
  event(event: NostrRumor, opts?: { signal?: AbortSignal }): Promise<void>;
  /** How many rumors match. */
  count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }>;
  /** Delete every rumor matching the filters. */
  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * A small key/value store for everything that isn't an event: sync cursors,
 * folded state, settings.
 *
 * Only JSON-serializable values are supported. The IndexedDB adapter stores
 * the native value (structured clone), the SQLite adapter
 * `JSON.stringify`/`parse`es it — so anything that doesn't survive a JSON
 * round-trip (`Map`, `Uint8Array`, `bigint`, `undefined`) is out of contract
 * and will differ between adapters. Encode such values yourself.
 */
export interface ArmadaKV {
  /** The value, or `undefined` if the key was never set. */
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  /** Forget a key. Deleting one that was never set is a no-op, not an error. */
  delete(key: string): Promise<void>;
  /**
   * The entries the selector picks out — KEY AND VALUE, in one round trip.
   *
   * This is how a subsystem gets enumeration out of a store that is otherwise
   * addressed by exact key: give related entries a shared key prefix and scan
   * it. Every adapter pushes the selector down to a range scan, so the cost is
   * in what matches, not in what's stored.
   *
   * Values come back with the keys deliberately. The enumeration this replaced
   * handed back keys alone, so every caller followed it with one `get` per key
   * — a bridge round trip each on Android, against rows the scan had already
   * visited. Nothing needed the keys on their own.
   *
   * The order is each adapter's native string collation — IndexedDB compares
   * UTF-16 code units, SQLite's `BINARY` compares UTF-8 bytes — which agree on
   * everything except astral-plane characters. Sort yourself if you need an
   * order both adapters promise. `reverse` reverses that order rather than
   * imposing one, and `limit` then takes from the front of it.
   *
   * `start`/`end` are compared in that same collation, so a bound containing an
   * astral character is one the adapters can disagree about the membership of.
   * A key space built from hex, timestamps or relay URLs — which is all of them
   * — never reaches the disagreement.
   */
  list<T>(selector?: ArmadaKVSelector, opts?: ArmadaKVListOptions): Promise<ArmadaKVEntry<T>[]>;
}

/** One entry from {@link ArmadaKV.list}. */
export interface ArmadaKVEntry<T> {
  key: string;
  value: T;
}

/**
 * Which keys {@link ArmadaKV.list} covers: a prefix, an explicit half-open
 * range, or a prefix narrowed by one end of one. An empty selector is the whole
 * store.
 *
 * `start`/`end` are what makes this more than a prefix scan: a key space with an
 * ordered suffix (a timestamp, a sequence number) can be read from a cursor
 * forward, so resuming does not mean listing everything before it. As in
 * Deno.KV, giving `start` AND `end` alongside a `prefix` is rejected — the two
 * bounds already describe the range, and a prefix on top of them is either
 * redundant or a contradiction.
 */
export interface ArmadaKVSelector {
  /** Keys must start with this. */
  prefix?: string;
  /** Inclusive lower bound. */
  start?: string;
  /** Exclusive upper bound. */
  end?: string;
}

export interface ArmadaKVListOptions {
  /** At most this many entries. Unset means all of them. */
  limit?: number;
  /** Walk the key order backwards (descending). */
  reverse?: boolean;
}

/**
 * A tenant's DERIVED index terms: facts about a rumor that are re-derivable
 * from it at any time, but that no tag of its own states.
 *
 * A NIP-01 filter can only ask about what a rumor literally says. Some of what
 * a reader needs to select on isn't said anywhere: a NIP-17 conversation is the
 * SET of its participants, which lives half in `pubkey` and half in the `p`
 * tags, and no filter can express "exactly this set" (a tag filter is an OR
 * over values, so it can only over-select and be narrowed in memory
 * afterwards).
 *
 * A term closes that gap without putting anything beside the rumor that a
 * reader could mistake for the rumor. The policy is a pure function of the
 * stored row, so a term is a CACHE of a derivation and never a fact of its own:
 * it can be thrown away and rebuilt, it can't be forged by a sender spelling a
 * tag, and nothing reads it back out — it exists only to be looked up. That is
 * what distinguishes it from injecting a tag into the stored rumor, which
 * AGENTS.md forbids and which this is not.
 *
 * Terms are queried as NIP-50 extension tokens — `{ search: "conv:<key>" }` —
 * and matched WHOLE and exactly against the strings the policy returned. The
 * engines never interpret a term, so nothing NIP-17-shaped is inside them; the
 * layer that spells the tenant id is the layer that decides what its rows mean
 * (see `termPolicy.ts`).
 *
 * A term is therefore `<namespace>:<body>`, with the namespace everything up to
 * the FIRST colon. That is not a new restriction — a token is the only way to
 * name a term in a filter, and it is reassembled as `key:value`, so a term
 * without a colon has never been queryable — but it is relied on by
 * {@link TERM_NAMESPACES_RESERVED} and by `distinct:<namespace>`, which reduces
 * a read to one rumor per term within one namespace. Two rules come with that:
 *
 *  - A policy must derive AT MOST ONE term per namespace per rumor. A rumor that
 *    is the newest of two groups can only be returned once (a read de-duplicates
 *    by id), so the second group would silently lose its representative.
 *  - A namespace in {@link TERM_NAMESPACES_RESERVED} is a directive, not a term,
 *    and a term under one could never be looked up.
 *
 * The policy is bound to the TENANT rather than passed at each write, because
 * two of the writers aren't in JavaScript: Android's notification service and
 * iOS's notification extension write into `dm17:<self>` while the app is dead,
 * through their own engines. A per-write option is one every writer has to
 * remember, and a writer that forgets it stores a row that a term read then
 * cannot see — which is exactly the message-received-while-closed case. Bound
 * to the tenant, a writer is covered whether or not it knows terms exist; the
 * native engines declare the same policy for the same tenant ids
 * (`TermPolicy.kt`, `TermPolicy.swift`).
 */
export type TermPolicy = (rumor: NostrRumor, tenantId: string) => string[];

/** Separates a term's namespace from its body. See {@link TermPolicy}. */
export const TERM_NAMESPACE_SEP = ":";

/**
 * Extension-token keys that are DIRECTIVES to the store rather than terms, and
 * so are not available as term namespaces.
 *
 * Currently one: `distinct:<namespace>` collapses a read to the newest rumor per
 * term in that namespace (ditto-relay spells the same operation `distinct:author`
 * over a field). A policy deriving `distinct:…` would be deriving a term no
 * filter could ever name, since the filter parser reads it as the directive.
 */
export const TERM_NAMESPACES_RESERVED: readonly string[] = ["distinct"];

export interface TenantOpts {
  /**
   * The tenant's {@link TermPolicy}, installed on the store and applied to
   * every write — including ones made through a handle acquired without it,
   * since a tenant is one store however many times it is asked for.
   *
   * Declare it at the single site that spells the tenant id. A second
   * acquisition may repeat it (it replaces the installed one, which is a no-op
   * when they agree), but two sites that DISAGREE are a bug the store can't
   * detect: rows already written keep the terms of the policy in force at the
   * time.
   *
   * Installing a policy on a tenant whose rows predate it schedules a one-time
   * backfill of that tenant's index; reads that name a term wait for it.
   */
  terms?: TermPolicy;
  /**
   * Which revision of {@link terms} the index was built by — bumped whenever a
   * policy changes what it derives, so the rows written under the old one are
   * re-indexed instead of being left with terms nothing looks up.
   *
   * The backfill records this alongside the tenant, and a recorded generation
   * that differs from the one asked for makes the tenant's terms be dropped and
   * derived again. Without it a policy edit is silent and permanent: existing
   * rows keep the terms they were written with, a term read returns only the
   * rows written since, and nothing anywhere reports a problem.
   *
   * It is ONE number for every policy, and the same number in every port
   * (`TERM_GENERATION` here, `TermPolicies.GENERATION` in Kotlin,
   * `TermPolicies.generation` in Swift) — because it is written into a file that
   * three engines share. Two ports that disagree would each read the other's
   * generation as stale and rebuild the index on every open, forever. A
   * per-policy number would be three tables to keep in step rather than one
   * constant, and buys only that an unrelated tenant is not re-walked.
   */
  termsGeneration?: number;
}

export interface ArmadaDB {
  /**
   * The event store for `id`, created on first use. Repeated calls with the
   * same id return the same store, so writes batch together.
   */
  tenant(id: string, opts?: TenantOpts): NRumorStore;
  kv: ArmadaKV;
}

export interface ArmadaDBOpts {
  /**
   * Which tags to index, as `[name, value]` pairs — only these are queryable
   * with a `#x` filter. Defaults to {@link defaultIndexTags}.
   */
  indexTags?(rumor: NostrRumor): string[][];
}

/**
 * The tag name an engine may use to file a {@link TermPolicy}'s terms in its
 * ORDINARY tag index, rather than in an index of their own — which is what the
 * IndexedDB adapter does, `NIndexedDB`'s `indexTags` hook being the only place
 * it can add an index term at all.
 *
 * Reserved: {@link defaultIndexTags} refuses it, so nothing a sender writes can
 * reach the namespace, and a term is only ever a string a policy returned.
 * (Adapters verify the derivation anyway — see `matchesTerms` — so this is the
 * second lock on the same door.)
 */
export const TERM_TAG = "~";

/**
 * Default tag index policy: index every tag with a short name and a non-empty
 * value under 200 chars, except the reserved {@link TERM_TAG}.
 *
 * Unlike relay/`NPostgres` policy this is NOT limited to single-letter tags —
 * Armada's local planes query on multi-letter names (`#channel`, `#stream`,
 * `#peer`) and there is no relay on the other side to negotiate with. The
 * value length cap is what keeps blobs (a serialized seal, an embedded proof)
 * out of the index.
 */
export function defaultIndexTags(rumor: NostrRumor): string[][] {
  return rumor.tags.filter(
    ([name, value]) =>
      !!name && name !== TERM_TAG && name.length <= 20 && !!value && value.length < 200,
  );
}

/**
 * The exclusive upper bound of the key range starting with `prefix`, or
 * `undefined` when there isn't one — an empty prefix, or a prefix ending in the
 * maximal code unit, both of which are open-ended.
 *
 * Shared by the adapters' {@link ArmadaKV.list} so they narrow their scans the
 * same way. It is only ever a NARROWING: the two engines' collations disagree
 * about astral-plane characters, so a range can admit a key that doesn't
 * actually start with the prefix, and every adapter filters the result rather
 * than trust the bound.
 */
export function prefixUpperBound(prefix: string): string | undefined {
  if (!prefix) return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last === 0xffff) return undefined;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * The half-open term range a namespace covers: every term of the form
 * `<namespace>:<anything>`.
 *
 * The engines compute this rather than being handed a prefix, so that a prefix
 * SPANNING namespaces cannot be spelled. `distinct:conv` collapsing groups from
 * `conv:`, `convmsg:` and `convmine:` at once would be a silently wrong answer —
 * every conversation returned up to three times, each with a different newest
 * row — and a missing trailing delimiter would be enough to ask for it.
 *
 * Splitting a term on its first colon is the only interpreting of a term any
 * engine does, and it is the delimiter the read path already required (see
 * {@link TermPolicy}). A trailing delimiter on the namespace is tolerated, so
 * `distinct:conv` and `distinct:conv:` name the same range.
 */
export function termNamespaceRange(
  namespace: string,
): { lower: string; upper: string | undefined } | undefined {
  const name = namespace.endsWith(TERM_NAMESPACE_SEP) ? namespace.slice(0, -1) : namespace;
  if (!name || name.includes(TERM_NAMESPACE_SEP)) return undefined;
  const lower = name + TERM_NAMESPACE_SEP;
  return { lower, upper: prefixUpperBound(lower) };
}

/**
 * An {@link ArmadaKVSelector} reduced to what an engine can scan: a half-open
 * key range, plus the prefix the range is only an approximation of.
 */
export interface KvRange {
  /** Inclusive lower bound; `undefined` means unbounded below. */
  lower?: string;
  /** Exclusive upper bound; `undefined` means unbounded above. */
  upper?: string;
  /** Keys must start with this. `""` when the selector named no prefix. */
  prefix: string;
  /**
   * Whether the bounds cross, so nothing can match — a `start` past the end of
   * its own prefix, an `end` at or below `start`.
   *
   * Carried as a flag because an inverted range has no faithful representation
   * to hand an engine: `IDBKeyRange.bound` throws on one, and SQL would answer
   * it correctly but only by accident of the comparison. Adapters check this and
   * answer with nothing.
   */
  empty: boolean;
  /**
   * Whether the bounds alone select exactly the keys the selector accepts, so
   * {@link matchesKvRange} can only ever agree with them.
   *
   * An engine may push a `limit` into the scan when this holds, and must not
   * otherwise: a scan that stops at `limit` rows and then drops some of them to
   * the filter would answer with fewer entries than exist.
   */
  exact: boolean;
}

/** Whether `text` holds a surrogate code unit — see {@link resolveKvRange}. */
function hasSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Resolve a selector into the range an engine scans, shared by every adapter
 * (and ported as `KvRange.resolve` in `SqliteArmadaDb.kt`, which Android's
 * native store plans with) so they all narrow the same way.
 *
 * @throws TypeError if `prefix` is combined with both `start` and `end`.
 */
export function resolveKvRange(selector: ArmadaKVSelector = {}): KvRange {
  const { prefix = "", start, end } = selector;
  if (prefix && start !== undefined && end !== undefined) {
    throw new TypeError("A KV selector cannot combine a prefix with both start and end");
  }

  // The bounds are the INTERSECTION of what the prefix implies and what the
  // caller asked for, so a `start` outside the prefix narrows to nothing rather
  // than escaping it.
  const prefixUpper = prefixUpperBound(prefix);
  const lower = start !== undefined && start > prefix ? start : prefix || undefined;
  const upper = end !== undefined && (prefixUpper === undefined || end < prefixUpper)
    ? end
    : prefixUpper;

  return {
    lower,
    upper,
    prefix,
    empty: lower !== undefined && upper !== undefined && lower >= upper,
    exact: boundsAreExact(lower, upper, prefix),
  };
}

/**
 * Whether a scan of `[lower, upper)` can admit only keys the selector accepts.
 *
 * Two things spoil it. An open-ended scan under a non-empty prefix (a prefix
 * ending in the maximal code unit) reads the whole tail of the store. And a
 * bound containing a surrogate code unit is a bound the engines order
 * differently: SQLite compares UTF-8 bytes, where astral characters sort ABOVE
 * U+E000-U+FFFF, while IndexedDB compares UTF-16 code units, where they sort
 * below — and a lone surrogate has no UTF-8 form at all, so SQLite's bundled
 * driver substitutes U+FFFD and the bound stops meaning what it says.
 *
 * Nothing Armada stores goes near either case; this is what keeps the one that
 * someday might from silently getting short answers.
 */
function boundsAreExact(lower: string | undefined, upper: string | undefined, prefix: string): boolean {
  if (prefix && upper === undefined) return false;
  return !hasSurrogate(lower ?? "") && !hasSurrogate(upper ?? "");
}

/**
 * Whether `key` is genuinely in `range` — the contract the bounds only
 * approximate. Every adapter filters its scan through this.
 *
 * It can only ever REMOVE rows the engine's range admitted. Where the two
 * collations disagree about a bound the engine's own ordering decides what was
 * scanned in the first place, which is the caveat {@link ArmadaKV.list}
 * documents; this is not a place that could paper over it.
 */
export function matchesKvRange(key: string, range: KvRange): boolean {
  if (range.prefix && !key.startsWith(range.prefix)) return false;
  if (range.lower !== undefined && key < range.lower) return false;
  if (range.upper !== undefined && key >= range.upper) return false;
  return true;
}

/**
 * The profiler label for a tenant: its CLASS (`c2:*`, `nip29:*`, `main`), not
 * its id.
 *
 * A per-id label would mint one bucket per community and per relay, scattering
 * the very total the profile exists to show — and a fix acts on the class
 * anyway ("the control planes cost 3s", not "this one did"). Shared by both
 * adapters so a web profile and a phone profile can be read side by side.
 */
export function tenantClass(id: string): string {
  const head = id.split(":", 1)[0];
  return head === id ? id : `${head}:*`;
}
