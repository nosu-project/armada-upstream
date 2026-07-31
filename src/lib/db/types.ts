/**
 * ArmadaDB — the shape all Armada client data is meant to converge on, with
 * one adapter per platform storage engine (IndexedDB on web, SQLite on
 * native/OPFS).
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
   * One caveat on NIP-50 `search`, the only place the adapters don't agree
   * exactly: SQLite resolves it against an FTS5 index, so keywords match whole
   * **words** (case- and accent-insensitively), while IndexedDB scans content
   * for **substrings**. `brown` finds "the quick brown fox" on both; `brow`
   * finds it only on IndexedDB.
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
