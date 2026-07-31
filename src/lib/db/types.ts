/**
 * ArmadaDB — the shape all Armada client data is meant to converge on, with
 * one adapter per platform storage engine (IndexedDB everywhere today, SQLite
 * once a driver exists for it — see `armadaDB.ts`).
 *
 * Two ideas carry the whole surface:
 *
 *  - **Tenants.** A tenant is an isolated event namespace addressed by an
 *    opaque string id, e.g. `c2:${concordId}` for a Concord community,
 *    `dm17:${pubkey}` for a DM inbox, `relay` for the relay cache. Ids never
 *    collide across tenants: the same rumor id can be stored in two tenants
 *    independently, and a query in one never sees the other.
 *  - **Rumors, not events.** Everything Armada stores locally is *already
 *    authenticated* by the time it lands (a signature check, or gift-wrap
 *    decryption which authenticates by construction), so the store deals in
 *    signature-less rumors and never carries a `sig` it would have to lie
 *    about. Provenance that has no home in the rumor itself is folded into
 *    tags by the caller.
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
   * Every key currently set, restricted to those starting with `prefix` when
   * one is given (an empty prefix means all of them).
   *
   * The order is each adapter's native string collation — IndexedDB compares
   * UTF-16 code units, SQLite's `BINARY` compares UTF-8 bytes — which agree on
   * everything except astral-plane characters. Sort yourself if you need an
   * order both adapters promise.
   *
   * This is how a subsystem gets enumeration out of a store that is otherwise
   * addressed by exact key: give related entries a shared key prefix and scan
   * it. Both adapters push the prefix down to a range scan, so the cost is in
   * what matches, not in what's stored.
   */
  keys(prefix?: string): Promise<string[]>;
}

export interface ArmadaDB {
  /**
   * The event store for `id`, created on first use. Repeated calls with the
   * same id return the same store, so writes batch together.
   */
  tenant(id: string): NRumorStore;
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
 * Default tag index policy: index every tag with a short name and a non-empty
 * value under 200 chars.
 *
 * Unlike relay/`NPostgres` policy this is NOT limited to single-letter tags —
 * Armada's local planes query on multi-letter names (`#channel`, `#stream`,
 * `#peer`) and there is no relay on the other side to negotiate with. The
 * value length cap is what keeps blobs (a serialized seal, an embedded proof)
 * out of the index.
 */
export function defaultIndexTags(rumor: NostrRumor): string[][] {
  return rumor.tags.filter(
    ([name, value]) => !!name && name.length <= 20 && !!value && value.length < 200,
  );
}

/**
 * The exclusive upper bound of the key range starting with `prefix`, or
 * `undefined` when there isn't one — an empty prefix, or a prefix ending in the
 * maximal code unit, both of which are open-ended.
 *
 * Shared by the adapters' {@link ArmadaKV.keys} so they narrow their scans the
 * same way. It is only ever a NARROWING: the two engines' collations disagree
 * about astral-plane characters, so a range can admit a key that doesn't
 * actually start with the prefix, and both adapters filter the result rather
 * than trust the bound.
 */
export function prefixUpperBound(prefix: string): string | undefined {
  if (!prefix) return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last === 0xffff) return undefined;
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}
