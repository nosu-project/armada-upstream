import { NKinds } from "@nostrify/nostrify";

import { filterToSql } from "./filterToSql";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { SqlDriver, SqlStatement } from "./driver";

/**
 * The Nostr event store over a {@link SqlDriver} — the single filter/write
 * engine for every platform (WASM+OPFS on web/Electron, the shared native
 * Android database via the Capacitor bridge). Semantics are a faithful port
 * of NIndexedDB (the strfry-derived IndexedDB store this replaces):
 *
 *  - Ephemeral kinds (20000–29999) are never stored.
 *  - Replaceable (0, 3, 10000–19999) and addressable (30000–39999) events
 *    supersede older versions at the same (kind, pubkey, d) coordinate;
 *    a stale write is skipped entirely. NIP-01 tie-break: on equal
 *    created_at the smaller id wins.
 *  - NIP-09 kind-5 deletion requests are applied on write (`e` by id, `a`
 *    by coordinate), only against the requester's own events; the request
 *    itself is retained.
 *  - Writes are batched: `event()` accumulates and a burst flushes as ONE
 *    transaction shortly after (requestIdleCallback / setTimeout), keeping
 *    writes off the render-critical path. The returned promise resolves once
 *    the batch has committed (ingest awaits it before ringing the wire bus).
 *
 * Everything is expressed as guarded SQL (no read-modify-write), so the
 * supersession/deletion logic stays atomic even with a SECOND writer on the
 * same database — on Android the notification service inserts events with
 * the exact same statement shapes (SharedEventDb.java mirrors them).
 */
export class SqliteEventStore {
  private pendingWrites = new Map<string, NostrEvent>();
  private pendingResolvers: Array<() => void> = [];
  private flushScheduled = false;

  constructor(
    private readonly driver: Promise<SqlDriver>,
    private readonly opts: { src?: string } = {},
  ) {}

  /**
   * Tag index policy (matches NIndexedDB.indexTags / NPostgres): every
   * single-letter tag with a non-empty value under 200 chars is queryable.
   */
  static indexTags(event: NostrEvent): string[][] {
    return event.tags.filter(([name, value]) => name?.length === 1 && !!value && value.length < 200);
  }

  // ── Write path ───────────────────────────────────────────────────────────

  event(event: NostrEvent, _opts?: { signal?: AbortSignal }): Promise<void> {
    if (NKinds.ephemeral(event.kind)) return Promise.resolve();

    this.pendingWrites.set(event.id, event);
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
    const events = [...this.pendingWrites.values()];
    const resolvers = this.pendingResolvers;
    this.pendingWrites = new Map();
    this.pendingResolvers = [];
    if (events.length === 0) {
      for (const resolve of resolvers) resolve();
      return;
    }

    const statements: SqlStatement[] = [];
    for (const ev of events) {
      statements.push(...SqliteEventStore.insertStatements(ev, this.opts.src ?? "web"));
    }
    // NIP-09 after the puts (same order as NIndexedDB): a kind 5 and its
    // targets arriving in one batch still resolve, and the request survives.
    for (const ev of events) {
      if (ev.kind === 5) statements.push(...SqliteEventStore.deletionStatements(ev));
    }

    try {
      const driver = await this.driver;
      await driver.run(statements);
    } catch {
      // Write failure is non-critical — the cache just won't have these events.
    } finally {
      for (const resolve of resolvers) resolve();
    }
  }

  /**
   * The guarded INSERT + supersession statements for one event. Mirrored in
   * Java by SharedEventDb.insertEvent — keep the two in sync.
   */
  static insertStatements(ev: NostrEvent, src: string): SqlStatement[] {
    const replaceable = NKinds.replaceable(ev.kind) || NKinds.addressable(ev.kind);
    const d = NKinds.addressable(ev.kind) ? SqliteEventStore.getDTag(ev) : "";
    const statements: SqlStatement[] = [];

    if (replaceable) {
      // Insert only if no stored version at this coordinate is newer
      // (created_at greater, or equal with a smaller id).
      statements.push({
        sql: `INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, d, content, raw, src)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM events
            WHERE pubkey = ? AND kind = ? AND d = ?
              AND (created_at > ? OR (created_at = ? AND id < ?))
          )`,
        params: [
          ev.id, ev.pubkey, ev.kind, ev.created_at, d, ev.content, JSON.stringify(ev), src,
          ev.pubkey, ev.kind, d, ev.created_at, ev.created_at, ev.id,
        ],
      });
      // Delete superseded versions — but only if OUR event survived the
      // insert (the EXISTS guard), so a stale write deletes nothing.
      statements.push({
        sql: `DELETE FROM tags WHERE event_id IN (
            SELECT id FROM events WHERE pubkey = ? AND kind = ? AND d = ? AND id <> ?
          ) AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
        params: [ev.pubkey, ev.kind, d, ev.id, ev.id],
      });
      statements.push({
        sql: `DELETE FROM events
          WHERE pubkey = ? AND kind = ? AND d = ? AND id <> ?
            AND EXISTS (SELECT 1 FROM events WHERE id = ?)`,
        params: [ev.pubkey, ev.kind, d, ev.id, ev.id],
      });
    } else {
      statements.push({
        sql: `INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, d, content, raw, src)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [ev.id, ev.pubkey, ev.kind, ev.created_at, d, ev.content, JSON.stringify(ev), src],
      });
    }

    // Tag rows, guarded on the event row existing (a superseded replaceable
    // write must not leave orphan tags). INSERT OR IGNORE + the composite PK
    // make re-runs idempotent.
    const seen = new Set<string>();
    for (const [name, value] of SqliteEventStore.indexTags(ev)) {
      const key = `${name}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      statements.push({
        sql: `INSERT OR IGNORE INTO tags (event_id, name, value)
          SELECT id, ?, ? FROM events WHERE id = ?`,
        params: [name, value, ev.id],
      });
    }

    return statements;
  }

  /** NIP-09: the deletes for one kind-5 request. Mirrored in Java. */
  static deletionStatements(request: NostrEvent): SqlStatement[] {
    const statements: SqlStatement[] = [];
    for (const [name, value] of request.tags) {
      if (!value) continue;
      if (name === "e") {
        if (value === request.id) continue; // never delete the request itself
        statements.push({
          sql: `DELETE FROM tags WHERE event_id IN (
              SELECT id FROM events WHERE id = ? AND pubkey = ?)`,
          params: [value, request.pubkey],
        });
        statements.push({
          sql: `DELETE FROM events WHERE id = ? AND pubkey = ?`,
          params: [value, request.pubkey],
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
          sql: `DELETE FROM tags WHERE event_id IN (
              SELECT id FROM events
              WHERE pubkey = ? AND kind = ? AND d = ? AND created_at <= ?)`,
          params: [pubkey, kind, d, request.created_at],
        });
        statements.push({
          sql: `DELETE FROM events
            WHERE pubkey = ? AND kind = ? AND d = ? AND created_at <= ?`,
          params: [pubkey, kind, d, request.created_at],
        });
      }
    }
    return statements;
  }

  // ── Read path ────────────────────────────────────────────────────────────

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]> {
    opts?.signal?.throwIfAborted();
    const driver = await this.driver;

    const byId = new Map<string, NostrEvent>();
    for (const filter of filters) {
      const compiled = filterToSql(filter);
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
          const ev = JSON.parse(String(row[0])) as NostrEvent;
          byId.set(ev.id, ev);
        } catch {
          // corrupt row — skip
        }
      }
    }

    return [...byId.values()].sort(SqliteEventStore.compareNewest);
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    if (filters.length === 1 && filters[0].limit === undefined) {
      const compiled = filterToSql(filters[0], { count: true });
      if (!compiled) return { count: 0, approximate: false };
      try {
        const driver = await this.driver;
        const rows = await driver.query(compiled.sql, compiled.params);
        return { count: Number(rows[0]?.[0] ?? 0), approximate: false };
      } catch {
        return { count: 0, approximate: false };
      }
    }
    const events = await this.query(filters, opts);
    return { count: events.length, approximate: false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    const events = await this.query(filters, opts);
    if (events.length === 0) return;
    const statements: SqlStatement[] = [];
    // Chunk the id lists to keep statements bounded.
    for (let i = 0; i < events.length; i += 100) {
      const ids = events.slice(i, i + 100).map((e) => e.id);
      const marks = ids.map(() => "?").join(",");
      statements.push({ sql: `DELETE FROM tags WHERE event_id IN (${marks})`, params: ids });
      statements.push({ sql: `DELETE FROM events WHERE id IN (${marks})`, params: ids });
    }
    try {
      const driver = await this.driver;
      await driver.run(statements);
    } catch {
      // Non-critical.
    }
  }

  /** Empty the store (logout purge). Keeps the schema; drops every row. */
  async wipe(): Promise<void> {
    const driver = await this.driver;
    await driver.run([{ sql: "DELETE FROM tags" }, { sql: "DELETE FROM events" }]);
  }

  async close(): Promise<void> {
    const driver = await this.driver;
    await driver.close();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private static getDTag(event: NostrEvent): string {
    return event.tags.find(([name]) => name === "d")?.[1] ?? "";
  }

  /** Newest-first; ties broken by smaller id first (NIP-01). */
  private static compareNewest(a: NostrEvent, b: NostrEvent): number {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  [Symbol.toStringTag] = "SqliteEventStore";
}
