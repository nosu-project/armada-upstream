/**
 * The IndexedDB adapter for {@link ArmadaDB} — the web/Electron backend.
 *
 * Each tenant is its own IndexedDB database wrapping Nostrify's `NIndexedDB`
 * (a strfry-derived query planner: id / tag / pubkey+kind index cascade,
 * batched writes, replaceable supersession, NIP-09 on write). Rumors are
 * stored as events with an empty `sig`, which is stripped again on read —
 * the field is never exposed and never trusted.
 *
 * One database per tenant, rather than one shared database with a tenant
 * column, because IndexedDB has no cheap way to prefix every index: scoping
 * would mean rebuilding the planner around composite keys. Separate databases
 * get isolation for free, and a tenant can be dropped with a single
 * `deleteDatabase`.
 */
import { NIndexedDB } from "@nostrify/indexeddb";
import { openDB } from "idb";

import { defaultIndexTags, prefixUpperBound } from "./types";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { DBSchema, IDBPDatabase } from "idb";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaDB, ArmadaDBOpts, ArmadaKV, NRumorStore } from "./types";

/** Strip the placeholder signature `NIndexedDB` round-trips. */
function toRumor(event: NostrEvent): NostrRumor {
  const { sig: _sig, ...rumor } = event;
  return rumor;
}

/** Present a rumor as an event for `NIndexedDB`, which types `sig` required. */
function toEvent(rumor: NostrRumor): NostrEvent {
  return { ...rumor, sig: "" };
}

class IndexedDBRumorStore implements NRumorStore {
  private readonly store: NIndexedDB;

  constructor(name: string, indexTags: (rumor: NostrRumor) => string[][]) {
    this.store = new NIndexedDB(name, { indexTags: (event) => indexTags(event) });
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    const events = await this.store.query(filters, opts);
    return events.map(toRumor);
  }

  event(event: NostrRumor, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.store.event(toEvent(event), opts);
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    const { count, approximate } = await this.store.count(filters, opts);
    return { count, approximate: approximate ?? false };
  }

  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    return this.store.remove(filters, opts);
  }

  close(): Promise<void> {
    return this.store.close();
  }

  [Symbol.toStringTag] = "IndexedDBRumorStore";
}

interface KVSchema extends DBSchema {
  kv: { key: string; value: unknown };
  /**
   * Every tenant id this instance has ever opened — the durable registry a
   * purge needs to find the per-tenant databases on a browser with no
   * `indexedDB.databases()` to enumerate (Firefox). Its own object store
   * rather than a reserved key in `kv`, so it can never collide with a
   * caller's key.
   */
  tenants: { key: string; value: true };
}

/** Bumped when {@link KVSchema} gains a store. */
const KV_DB_VERSION = 2;

/**
 * KV over its own database, which also holds the tenant registry. Values are
 * stored natively (structured clone), so a JSON round-trip is never paid.
 *
 * Every operation degrades to a no-op when IndexedDB is unavailable (iOS
 * Lockdown Mode, some private-browsing contexts), matching `NIndexedDB`.
 */
class IndexedDBKV implements ArmadaKV {
  private readonly db: Promise<IDBPDatabase<KVSchema> | null>;
  /** Tenant ids already written, so repeated `tenant()` calls stay free. */
  private readonly registered = new Set<string>();

  constructor(name: string) {
    this.db = IndexedDBKV.open(name);
  }

  private static async open(name: string): Promise<IDBPDatabase<KVSchema> | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      return await openDB<KVSchema>(name, KV_DB_VERSION, {
        upgrade(db) {
          // Idempotent: an upgrade from v1 already has `kv`, a fresh open has
          // neither.
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
          if (!db.objectStoreNames.contains("tenants")) db.createObjectStore("tenants");
        },
      });
    } catch {
      return null;
    }
  }

  /** Record that `id` has a tenant database (best-effort, fire-and-forget). */
  async rememberTenant(id: string): Promise<void> {
    if (this.registered.has(id)) return;
    this.registered.add(id);
    try {
      const db = await this.db;
      await db?.put("tenants", true, id);
    } catch {
      // A purge still finds open tenants via the in-memory map.
      this.registered.delete(id);
    }
  }

  /** Every tenant id recorded by this or a previous session. */
  async knownTenants(): Promise<string[]> {
    try {
      const db = await this.db;
      return db ? ((await db.getAllKeys("tenants")) as string[]) : [];
    } catch {
      return [];
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.db;
    if (!db) return undefined;
    try {
      return (await db.get("kv", key)) as T | undefined;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const db = await this.db;
    if (!db) return;
    // `undefined` is out of contract (it has no JSON form); normalize to null
    // so both adapters agree instead of one storing a hole.
    await db.put("kv", value === undefined ? null : value, key);
  }

  async delete(key: string): Promise<void> {
    const db = await this.db;
    if (!db) return;
    await db.delete("kv", key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const db = await this.db;
    if (!db) return [];
    try {
      const upper = prefix ? prefixUpperBound(prefix) : undefined;
      const range = !prefix
        ? undefined
        : upper === undefined
        ? IDBKeyRange.lowerBound(prefix)
        : IDBKeyRange.bound(prefix, upper, false, true);
      const keys = (await db.getAllKeys("kv", range)) as string[];
      // The range is a scan hint, not the contract — see `prefixUpperBound`.
      return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    (await this.db)?.close();
  }
}

export class IndexedDBArmadaDB implements ArmadaDB {
  private readonly stores = new Map<string, IndexedDBRumorStore>();
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  readonly kv: IndexedDBKV;

  /**
   * @param name Prefix for the IndexedDB databases this instance owns:
   *   `${name}:kv` and one `${name}:t:${tenantId}` per tenant.
   */
  constructor(
    private readonly name: string,
    opts: ArmadaDBOpts = {},
  ) {
    this.indexTags = opts.indexTags ?? defaultIndexTags;
    this.kv = new IndexedDBKV(`${name}:kv`);
  }

  tenant(id: string): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new IndexedDBRumorStore(IndexedDBArmadaDB.databaseName(this.name, id), this.indexTags);
      this.stores.set(id, store);
      // Registered on open, not on first write: an empty tenant still has a
      // database, and a purge has to delete that too.
      void this.kv.rememberTenant(id);
    }
    return store;
  }

  /**
   * Every tenant id this instance owns a database for — recorded in the
   * registry, or opened this session and possibly not yet flushed to it.
   */
  async tenantIds(): Promise<string[]> {
    return [...new Set([...(await this.kv.knownTenants()), ...this.stores.keys()])];
  }

  /**
   * The IndexedDB database backing a tenant. Exposed so a purge can delete
   * tenant databases without opening them.
   */
  static databaseName(name: string, tenantId: string): string {
    return `${name}:t:${tenantId}`;
  }

  /** Close every connection this instance opened. */
  async close(): Promise<void> {
    const stores = [...this.stores.values()];
    this.stores.clear();
    await Promise.all([...stores.map((s) => s.close()), this.kv.close()]);
  }

  [Symbol.toStringTag] = "IndexedDBArmadaDB";
}
