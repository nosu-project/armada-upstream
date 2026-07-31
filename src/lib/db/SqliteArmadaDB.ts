/**
 * The SQLite adapter for {@link ArmadaDB} — the native/OPFS backend.
 *
 * One connection, one database: every tenant is a `tenant` column on the
 * shared `rumors`/`rumor_tags` tables (see sqliteSchema.ts), and the KV store
 * is a third table. Semantics match the IndexedDB adapter (i.e. `NIndexedDB`):
 *
 *  - Ephemeral kinds (20000–29999) are never stored.
 *  - Replaceable (0, 3, 10000–19999) and addressable (30000–39999) rumors
 *    supersede older versions at the same (tenant, kind, pubkey, d)
 *    coordinate; a stale write is skipped entirely. NIP-01 tie-break: on
 *    equal created_at the smaller id wins.
 *  - NIP-09 kind-5 deletion requests are applied on write (`e` by id, `a` by
 *    coordinate), only against the requester's own rumors in the same tenant;
 *    the request itself is retained.
 *  - Writes are batched across ALL tenants: `event()` accumulates and a burst
 *    flushes as ONE transaction shortly after (requestIdleCallback /
 *    setTimeout). The returned promise resolves once that batch has
 *    committed.
 *
 * Everything is expressed as guarded SQL (no read-modify-write), so
 * supersession and deletion stay atomic even with a SECOND writer on the same
 * database file — which is the situation on Android, where the notification
 * service writes to the same store.
 *
 * The adapter never runs DDL: the transport that owns the file installs
 * {@link ARMADA_DB_SCHEMA} (the native side owns its own schema).
 */
import { NKinds } from "@nostrify/nostrify";

import { rumorFilterToSql } from "./rumorFilterToSql";
import { defaultIndexTags } from "./types";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { SqlDriver, SqlStatement } from "@/lib/sqlite/driver";
import type { ArmadaDB, ArmadaDBOpts, ArmadaKV, NRumorStore } from "./types";

/** Newest-first; ties broken by smaller id first (NIP-01). */
function compareNewest(a: NostrRumor, b: NostrRumor): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function getDTag(rumor: NostrRumor): string {
  return rumor.tags.find(([name]) => name === "d")?.[1] ?? "";
}

/**
 * The guarded INSERT + supersession statements for one rumor in one tenant.
 */
export function insertStatements(
  tenant: string,
  rumor: NostrRumor,
  indexTags: (rumor: NostrRumor) => string[][],
): SqlStatement[] {
  const replaceable = NKinds.replaceable(rumor.kind) || NKinds.addressable(rumor.kind);
  const d = NKinds.addressable(rumor.kind) ? getDTag(rumor) : "";
  const statements: SqlStatement[] = [];

  if (replaceable) {
    // Insert only if no stored version at this coordinate is newer
    // (created_at greater, or equal with a smaller id).
    statements.push({
      sql: `INSERT OR IGNORE INTO rumors (tenant, id, pubkey, kind, created_at, d, content, raw)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM rumors
          WHERE tenant = ? AND pubkey = ? AND kind = ? AND d = ?
            AND (created_at > ? OR (created_at = ? AND id < ?))
        )`,
      params: [
        tenant, rumor.id, rumor.pubkey, rumor.kind, rumor.created_at, d, rumor.content,
        JSON.stringify(rumor),
        tenant, rumor.pubkey, rumor.kind, d, rumor.created_at, rumor.created_at, rumor.id,
      ],
    });
    // Delete superseded versions — but only if OUR rumor survived the insert
    // (the EXISTS guard), so a stale write deletes nothing.
    statements.push({
      sql: `DELETE FROM rumor_tags WHERE tenant = ? AND event_id IN (
          SELECT id FROM rumors WHERE tenant = ? AND pubkey = ? AND kind = ? AND d = ? AND id <> ?
        ) AND EXISTS (SELECT 1 FROM rumors WHERE tenant = ? AND id = ?)`,
      params: [tenant, tenant, rumor.pubkey, rumor.kind, d, rumor.id, tenant, rumor.id],
    });
    statements.push({
      sql: `DELETE FROM rumors
        WHERE tenant = ? AND pubkey = ? AND kind = ? AND d = ? AND id <> ?
          AND EXISTS (SELECT 1 FROM rumors WHERE tenant = ? AND id = ?)`,
      params: [tenant, rumor.pubkey, rumor.kind, d, rumor.id, tenant, rumor.id],
    });
  } else {
    statements.push({
      sql: `INSERT OR IGNORE INTO rumors (tenant, id, pubkey, kind, created_at, d, content, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        tenant, rumor.id, rumor.pubkey, rumor.kind, rumor.created_at, d, rumor.content,
        JSON.stringify(rumor),
      ],
    });
  }

  // Tag rows, guarded on the rumor row existing (a superseded replaceable
  // write must not leave orphan tags). INSERT OR IGNORE + the composite PK
  // make re-runs idempotent.
  const seen = new Set<string>();
  for (const [name, value] of indexTags(rumor)) {
    const key = `${name}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    statements.push({
      sql: `INSERT OR IGNORE INTO rumor_tags (tenant, event_id, name, value)
        SELECT tenant, id, ?, ? FROM rumors WHERE tenant = ? AND id = ?`,
      params: [name, value, tenant, rumor.id],
    });
  }

  return statements;
}

/** NIP-09: the deletes for one kind-5 request, scoped to its tenant. */
export function deletionStatements(tenant: string, request: NostrRumor): SqlStatement[] {
  const statements: SqlStatement[] = [];
  for (const [name, value] of request.tags) {
    if (!value) continue;
    if (name === "e") {
      if (value === request.id) continue; // never delete the request itself
      statements.push({
        sql: `DELETE FROM rumor_tags WHERE tenant = ? AND event_id IN (
            SELECT id FROM rumors WHERE tenant = ? AND id = ? AND pubkey = ?)`,
        params: [tenant, tenant, value, request.pubkey],
      });
      statements.push({
        sql: `DELETE FROM rumors WHERE tenant = ? AND id = ? AND pubkey = ?`,
        params: [tenant, value, request.pubkey],
      });
    } else if (name === "a") {
      const [kindStr, pubkey, ...rest] = value.split(":");
      const kind = Number(kindStr);
      // Only the author's own coordinates can be deleted by them.
      if (!Number.isInteger(kind) || pubkey !== request.pubkey) continue;
      const d = NKinds.addressable(kind) ? rest.join(":") : "";
      // Per NIP-09 only versions at or before the request's created_at go,
      // so a newer replacement survives.
      statements.push({
        sql: `DELETE FROM rumor_tags WHERE tenant = ? AND event_id IN (
            SELECT id FROM rumors
            WHERE tenant = ? AND pubkey = ? AND kind = ? AND d = ? AND created_at <= ?)`,
        params: [tenant, tenant, pubkey, kind, d, request.created_at],
      });
      statements.push({
        sql: `DELETE FROM rumors
          WHERE tenant = ? AND pubkey = ? AND kind = ? AND d = ? AND created_at <= ?`,
        params: [tenant, pubkey, kind, d, request.created_at],
      });
    }
  }
  return statements;
}

class SqliteRumorStore implements NRumorStore {
  constructor(
    private readonly tenant: string,
    private readonly db: SqliteArmadaDB,
  ) {}

  event(event: NostrRumor, _opts?: { signal?: AbortSignal }): Promise<void> {
    return this.db.enqueue(this.tenant, event);
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    opts?.signal?.throwIfAborted();
    const driver = await this.db.driver;

    const byId = new Map<string, NostrRumor>();
    for (const filter of filters) {
      const compiled = rumorFilterToSql(this.tenant, filter);
      if (!compiled) continue;
      let rows: unknown[][];
      try {
        rows = await driver.query(compiled.sql, compiled.params);
      } catch {
        continue; // a storage failure degrades to an empty result
      }
      opts?.signal?.throwIfAborted();
      for (const row of rows) {
        try {
          const rumor = JSON.parse(String(row[0])) as NostrRumor;
          byId.set(rumor.id, rumor);
        } catch {
          // corrupt row — skip
        }
      }
    }

    return [...byId.values()].sort(compareNewest);
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    if (filters.length === 1 && filters[0].limit === undefined) {
      const compiled = rumorFilterToSql(this.tenant, filters[0], { count: true });
      if (!compiled) return { count: 0, approximate: false };
      try {
        const driver = await this.db.driver;
        const rows = await driver.query(compiled.sql, compiled.params);
        return { count: Number(rows[0]?.[0] ?? 0), approximate: false };
      } catch {
        return { count: 0, approximate: false };
      }
    }
    const rumors = await this.query(filters, opts);
    return { count: rumors.length, approximate: false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    const rumors = await this.query(filters, opts);
    if (rumors.length === 0) return;
    const statements: SqlStatement[] = [];
    // Chunk the id lists to keep statements bounded.
    for (let i = 0; i < rumors.length; i += 100) {
      const ids = rumors.slice(i, i + 100).map((r) => r.id);
      const marks = ids.map(() => "?").join(",");
      statements.push({
        sql: `DELETE FROM rumor_tags WHERE tenant = ? AND event_id IN (${marks})`,
        params: [this.tenant, ...ids],
      });
      statements.push({
        sql: `DELETE FROM rumors WHERE tenant = ? AND id IN (${marks})`,
        params: [this.tenant, ...ids],
      });
    }
    try {
      const driver = await this.db.driver;
      await driver.run(statements);
    } catch {
      // Non-critical.
    }
  }

  [Symbol.toStringTag] = "SqliteRumorStore";
}

class SqliteKV implements ArmadaKV {
  constructor(private readonly driver: Promise<SqlDriver>) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const driver = await this.driver;
      const rows = await driver.query(`SELECT value FROM kv WHERE key = ?`, [key]);
      const raw = rows[0]?.[0];
      if (typeof raw !== "string") return undefined;
      return JSON.parse(raw) as T;
    } catch {
      return undefined; // missing, unreadable or corrupt — all "not set"
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    // `undefined` (and anything else without a JSON form) is out of contract;
    // normalize to null so both adapters agree instead of throwing here.
    const json = JSON.stringify(value) ?? "null";
    const driver = await this.driver;
    await driver.run([
      {
        sql: `INSERT INTO kv (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        params: [key, json],
      },
    ]);
  }
}

export class SqliteArmadaDB implements ArmadaDB {
  private readonly stores = new Map<string, SqliteRumorStore>();
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  /** Pending writes across all tenants, keyed `${tenant}\0${id}`. */
  private pendingWrites = new Map<string, { tenant: string; rumor: NostrRumor }>();
  /** Callers waiting for the current pending batch to commit. */
  private pendingResolvers: Array<() => void> = [];
  private flushScheduled = false;

  readonly driver: Promise<SqlDriver>;
  readonly kv: ArmadaKV;

  /**
   * @param driver The SQL transport. The schema ({@link ARMADA_DB_SCHEMA})
   *   must already be installed by whoever owns the file.
   */
  constructor(driver: Promise<SqlDriver> | SqlDriver, opts: ArmadaDBOpts = {}) {
    this.driver = Promise.resolve(driver);
    this.indexTags = opts.indexTags ?? defaultIndexTags;
    this.kv = new SqliteKV(this.driver);
  }

  tenant(id: string): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new SqliteRumorStore(id, this);
      this.stores.set(id, store);
    }
    return store;
  }

  /** Queue a rumor for the next batched flush. Resolves when it commits. */
  enqueue(tenant: string, rumor: NostrRumor): Promise<void> {
    if (NKinds.ephemeral(rumor.kind)) return Promise.resolve();

    // Dedupe within the burst; the latest copy of a given id wins.
    this.pendingWrites.set(`${tenant}\u0000${rumor.id}`, { tenant, rumor });
    const done = new Promise<void>((resolve) => {
      this.pendingResolvers.push(resolve);
    });
    this.scheduleFlush();
    return done;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = () => void this.flushWrites();
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 50 });
    } else {
      setTimeout(run, 0);
    }
  }

  private async flushWrites(): Promise<void> {
    this.flushScheduled = false;
    const writes = [...this.pendingWrites.values()];
    const resolvers = this.pendingResolvers;
    this.pendingWrites = new Map();
    this.pendingResolvers = [];
    if (writes.length === 0) {
      for (const resolve of resolvers) resolve();
      return;
    }

    const statements: SqlStatement[] = [];
    for (const { tenant, rumor } of writes) {
      statements.push(...insertStatements(tenant, rumor, this.indexTags));
    }
    // NIP-09 after the puts (same order as NIndexedDB): a kind 5 and its
    // targets arriving in one batch still resolve, and the request survives.
    for (const { tenant, rumor } of writes) {
      if (rumor.kind === 5) statements.push(...deletionStatements(tenant, rumor));
    }

    try {
      const driver = await this.driver;
      await driver.run(statements);
    } catch {
      // Write failure is non-critical — the store just won't have these rumors.
    } finally {
      for (const resolve of resolvers) resolve();
    }
  }

  async close(): Promise<void> {
    const driver = await this.driver;
    await driver.close();
  }

  [Symbol.toStringTag] = "SqliteArmadaDB";
}
