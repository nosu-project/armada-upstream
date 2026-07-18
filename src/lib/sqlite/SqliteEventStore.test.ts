// @vitest-environment node
/**
 * The SQLite event store, exercised against REAL SQLite (node:sqlite) — the
 * same statements run on SQLite-WASM (web/Electron) and Android framework
 * SQLite (SharedEventDb.java mirrors the statement shapes), so behavior
 * proven here holds on every backend: NIndexedDB-parity semantics
 * (replaceable/addressable supersession, NIP-09 deletion-on-write, ephemeral
 * skip) plus the drain-cursor contract the Android bridge relies on.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { EVENT_DB_SCHEMA } from "./schema";
import { SqliteEventStore } from "./SqliteEventStore";
import { filterToSql } from "./filterToSql";

import type { NostrEvent } from "@nostrify/nostrify";
import type { SqlDriver, SqlParam, SqlStatement } from "./driver";

class NodeSqlDriver implements SqlDriver {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    for (const stmt of EVENT_DB_SCHEMA) this.db.exec(stmt);
  }

  async run(statements: SqlStatement[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      for (const s of statements) {
        this.db.prepare(s.sql).run(...(s.params ?? []));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async query(sql: string, params?: SqlParam[]): Promise<SqlParam[][]> {
    const rows = this.db.prepare(sql).all(...(params ?? []));
    return rows.map((row) => Object.values(row as Record<string, SqlParam>));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

let seq = 0;

/** A minimal fake event (ids only need to be unique + ordered for ties). */
function ev(partial: Partial<NostrEvent>): NostrEvent {
  seq++;
  return {
    id: partial.id ?? `id-${String(seq).padStart(4, "0")}`,
    pubkey: "pk-default",
    kind: 1,
    created_at: 1000 + seq,
    content: "",
    tags: [],
    sig: "sig",
    ...partial,
  };
}

const drivers: NodeSqlDriver[] = [];

function makeStore(src = "web"): { store: SqliteEventStore; driver: NodeSqlDriver } {
  const driver = new NodeSqlDriver();
  drivers.push(driver);
  return { store: new SqliteEventStore(Promise.resolve(driver), { src }), driver };
}

afterEach(async () => {
  for (const d of drivers.splice(0)) await d.close().catch(() => undefined);
});

describe("SqliteEventStore", () => {
  it("stores and queries by kinds/authors/ids/tags/time, newest-first", async () => {
    const { store } = makeStore();
    const a = ev({ kind: 1, pubkey: "alice", created_at: 100 });
    const b = ev({ kind: 1, pubkey: "bob", created_at: 200, tags: [["e", a.id]] });
    const c = ev({ kind: 7, pubkey: "bob", created_at: 300 });
    await Promise.all([store.event(a), store.event(b), store.event(c)]);

    expect(await store.query([{ kinds: [1] }])).toEqual([b, a]);
    expect(await store.query([{ authors: ["bob"] }])).toEqual([c, b]);
    expect(await store.query([{ ids: [a.id] }])).toEqual([a]);
    expect(await store.query([{ "#e": [a.id] }])).toEqual([b]);
    expect(await store.query([{ kinds: [1], since: 150 }])).toEqual([b]);
    expect(await store.query([{ kinds: [1], until: 150 }])).toEqual([a]);
    expect(await store.query([{ kinds: [1], limit: 1 }])).toEqual([b]);
    // Multiple filters OR together, de-duplicated.
    expect(await store.query([{ ids: [a.id] }, { authors: ["alice"] }])).toEqual([a]);
    // Empty-array constraints never match.
    expect(await store.query([{ ids: [] }])).toEqual([]);
  });

  it("replaceable: newest wins, stale writes are skipped, ties break on smaller id", async () => {
    const { store } = makeStore();
    const older = ev({ kind: 0, pubkey: "alice", created_at: 100, content: "old" });
    const newer = ev({ kind: 0, pubkey: "alice", created_at: 200, content: "new" });
    await store.event(older);
    await store.event(newer);
    expect(await store.query([{ kinds: [0], authors: ["alice"] }])).toEqual([newer]);

    // A stale write after the fact is skipped entirely.
    const stale = ev({ kind: 0, pubkey: "alice", created_at: 150, content: "stale" });
    await store.event(stale);
    expect(await store.query([{ kinds: [0], authors: ["alice"] }])).toEqual([newer]);

    // created_at tie: the smaller id wins (NIP-01).
    const tieSmall = ev({ id: "aaaa", kind: 0, pubkey: "tie", created_at: 500 });
    const tieBig = ev({ id: "bbbb", kind: 0, pubkey: "tie", created_at: 500 });
    await store.event(tieBig);
    await store.event(tieSmall);
    expect(await store.query([{ kinds: [0], authors: ["tie"] }])).toEqual([tieSmall]);
  });

  it("replaceable supersession also drops the superseded event's tag rows", async () => {
    const { store, driver } = makeStore();
    const older = ev({ kind: 3, pubkey: "alice", created_at: 100, tags: [["p", "friend-old"]] });
    const newer = ev({ kind: 3, pubkey: "alice", created_at: 200, tags: [["p", "friend-new"]] });
    await store.event(older);
    await store.event(newer);
    expect(await store.query([{ "#p": ["friend-old"] }])).toEqual([]);
    expect(await store.query([{ "#p": ["friend-new"] }])).toEqual([newer]);
    const orphans = await driver.query(`SELECT COUNT(*) FROM tags WHERE event_id = ?`, [older.id]);
    expect(Number(orphans[0][0])).toBe(0);
  });

  it("addressable: coordinates are scoped by d-tag", async () => {
    const { store } = makeStore();
    const listA = ev({ kind: 30000, pubkey: "alice", created_at: 100, tags: [["d", "mute"]] });
    const listB = ev({ kind: 30000, pubkey: "alice", created_at: 200, tags: [["d", "pin"]] });
    await Promise.all([store.event(listA), store.event(listB)]);
    // Different d — both survive.
    expect(await store.query([{ kinds: [30000], authors: ["alice"] }])).toEqual([listB, listA]);

    const listA2 = ev({ kind: 30000, pubkey: "alice", created_at: 300, tags: [["d", "mute"]] });
    await store.event(listA2);
    expect(await store.query([{ kinds: [30000], authors: ["alice"] }])).toEqual([listA2, listB]);
  });

  it("never stores ephemeral events", async () => {
    const { store } = makeStore();
    await store.event(ev({ kind: 20001 }));
    expect(await store.query([{ kinds: [20001] }])).toEqual([]);
  });

  it("NIP-09: deletes the requester's own targets only, retains the request", async () => {
    const { store } = makeStore();
    const mine = ev({ kind: 1, pubkey: "alice" });
    const theirs = ev({ kind: 1, pubkey: "bob" });
    await Promise.all([store.event(mine), store.event(theirs)]);

    const del = ev({
      kind: 5,
      pubkey: "alice",
      tags: [["e", mine.id], ["e", theirs.id]],
    });
    await store.event(del);

    expect(await store.query([{ ids: [mine.id] }])).toEqual([]);
    expect(await store.query([{ ids: [theirs.id] }])).toEqual([theirs]); // not alice's to delete
    expect(await store.query([{ kinds: [5] }])).toEqual([del]); // request retained
  });

  it("NIP-09: `a` coordinate deletes spare newer replacements", async () => {
    const { store } = makeStore();
    const oldList = ev({ kind: 30000, pubkey: "alice", created_at: 100, tags: [["d", "mute"]] });
    await store.event(oldList);
    const del = ev({
      kind: 5,
      pubkey: "alice",
      created_at: 150,
      tags: [["a", "30000:alice:mute"]],
    });
    await store.event(del);
    expect(await store.query([{ kinds: [30000], authors: ["alice"] }])).toEqual([]);

    // A replacement NEWER than the deletion request survives it.
    const newList = ev({ kind: 30000, pubkey: "alice", created_at: 200, tags: [["d", "mute"]] });
    await store.event(newList);
    await store.event(ev({
      kind: 5,
      pubkey: "alice",
      created_at: 150,
      tags: [["a", "30000:alice:mute"]],
    }));
    expect(await store.query([{ kinds: [30000], authors: ["alice"] }])).toEqual([newList]);
  });

  it("search matches content substrings", async () => {
    const { store } = makeStore();
    const hit = ev({ kind: 1, content: "hello armada world" });
    const miss = ev({ kind: 1, content: "something else" });
    await Promise.all([store.event(hit), store.event(miss)]);
    expect(await store.query([{ kinds: [1], search: "armada" }])).toEqual([hit]);
    // LIKE wildcards in the term are literal.
    expect(await store.query([{ kinds: [1], search: "%" }])).toEqual([]);
  });

  it("count and remove and wipe", async () => {
    const { store } = makeStore();
    const a = ev({ kind: 1, pubkey: "alice" });
    const b = ev({ kind: 1, pubkey: "bob" });
    await Promise.all([store.event(a), store.event(b)]);
    expect((await store.count([{ kinds: [1] }])).count).toBe(2);
    await store.remove([{ authors: ["alice"] }]);
    expect((await store.count([{ kinds: [1] }])).count).toBe(1);
    await store.wipe();
    expect((await store.count([{ kinds: [1] }])).count).toBe(0);
  });

  it("drain contract: service rows come back in seq order, webview rows are excluded", async () => {
    // The Android drain reads `src='svc'` rows after a cursor — simulate the
    // service (insertStatements with src 'svc') and the webview writing to
    // the same database.
    const { store, driver } = makeStore("web");
    const svc1 = ev({ kind: 9, pubkey: "alice", tags: [["h", "group"]] });
    const web1 = ev({ kind: 1, pubkey: "bob" });
    const svc2 = ev({ kind: 4, pubkey: "carol" });

    await driver.run(SqliteEventStore.insertStatements(svc1, "svc"));
    await store.event(web1);
    await driver.run(SqliteEventStore.insertStatements(svc2, "svc"));

    const drainSql = `SELECT seq, raw FROM events WHERE seq > ? AND src = 'svc' ORDER BY seq ASC LIMIT ?`;
    const page = await driver.query(drainSql, [0, 500]);
    expect(page.map((r) => (JSON.parse(String(r[1])) as NostrEvent).id)).toEqual([svc1.id, svc2.id]);

    // Ack the first row; the next page starts after it.
    const afterFirst = await driver.query(drainSql, [Number(page[0][0]), 500]);
    expect(afterFirst.map((r) => (JSON.parse(String(r[1])) as NostrEvent).id)).toEqual([svc2.id]);

    // A duplicate arriving via BOTH transports stores once (id-deduped).
    await driver.run(SqliteEventStore.insertStatements(web1, "svc"));
    expect((await store.count([{ ids: [web1.id] }])).count).toBe(1);
  });
});

describe("filterToSql", () => {
  it("returns null for never-matching filters", () => {
    expect(filterToSql({ ids: [] })).toBeNull();
    expect(filterToSql({ kinds: [1], limit: 0 })).toBeNull();
  });
});
