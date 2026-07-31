// @vitest-environment node
/**
 * One conformance suite, run against BOTH ArmadaDB adapters — the IndexedDB
 * one (fake-indexeddb) and the SQLite one (real SQLite via node:sqlite). The
 * whole point of the interface is that a caller can't tell which it got, so
 * every behavioral claim is asserted twice, in the same words.
 */
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";
import { SqliteArmadaDB } from "./SqliteArmadaDB";
import { ARMADA_DB_SCHEMA } from "./sqliteSchema";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { SqlDriver, SqlParam, SqlStatement } from "@/lib/sqlite/driver";
import type { ArmadaDB } from "./types";

class NodeSqlDriver implements SqlDriver {
  private readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    for (const stmt of ARMADA_DB_SCHEMA) this.db.exec(stmt);
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

/** A minimal fake rumor (ids only need to be unique + ordered for ties). */
function rumor(partial: Partial<NostrRumor> = {}): NostrRumor {
  seq++;
  return {
    id: partial.id ?? `id-${String(seq).padStart(4, "0")}`,
    pubkey: "pk-default",
    kind: 1,
    created_at: 1000 + seq,
    content: "",
    tags: [],
    ...partial,
  };
}

interface Backend {
  name: string;
  create(): ArmadaDB & { close(): Promise<void> };
}

let dbSeq = 0;

const backends: Backend[] = [
  {
    name: "IndexedDBArmadaDB",
    create() {
      // A fresh factory (and a fresh name) per instance, so no test can see
      // another's databases.
      (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      return new IndexedDBArmadaDB(`armada-test-${++dbSeq}`);
    },
  },
  {
    name: "SqliteArmadaDB",
    create: () => new SqliteArmadaDB(new NodeSqlDriver()),
  },
];

describe.each(backends)("$name", ({ create }) => {
  let db: ArmadaDB & { close(): Promise<void> };

  beforeEach(() => {
    db = create();
  });

  afterEach(async () => {
    await db.close().catch(() => undefined);
  });

  describe("tenant stores", () => {
    it("stores a rumor and reads it back without a signature", async () => {
      const r = rumor({ kind: 1, content: "hello" });
      await db.tenant("c2:abc").event(r);

      const [got] = await db.tenant("c2:abc").query([{ kinds: [1] }]);

      expect(got).toEqual(r);
      expect(Object.keys(got)).not.toContain("sig");
    });

    it("returns the same store for the same tenant id", async () => {
      expect(db.tenant("c2:abc")).toBe(db.tenant("c2:abc"));
    });

    it("queries by a multi-letter tag", async () => {
      const channelId = "chan-1";
      const inChannel = rumor({ tags: [["channel", channelId]] });
      await db.tenant("c2:abc").event(inChannel);
      await db.tenant("c2:abc").event(rumor({ tags: [["channel", "chan-2"]] }));

      const events = await db.tenant("c2:abc").query([{ "#channel": [channelId] }]);

      expect(events).toEqual([inChannel]);
    });

    it("isolates tenants sharing a rumor id", async () => {
      const a = rumor({ id: "shared", content: "in a" });
      const b = { ...a, content: "in b" };
      await db.tenant("c2:a").event(a);
      await db.tenant("c2:b").event(b);

      expect(await db.tenant("c2:a").query([{}])).toEqual([a]);
      expect(await db.tenant("c2:b").query([{}])).toEqual([b]);
      expect(await db.tenant("c2:c").query([{}])).toEqual([]);
    });

    it("keeps a tag index in one tenant out of another", async () => {
      await db.tenant("c2:a").event(rumor({ tags: [["channel", "chan-1"]] }));

      expect(await db.tenant("c2:b").query([{ "#channel": ["chan-1"] }])).toEqual([]);
    });

    it("filters by ids, authors, kinds and time bounds", async () => {
      const store = db.tenant("t");
      const target = rumor({ id: "wanted", pubkey: "alice", kind: 7, created_at: 500 });
      await store.event(target);
      await store.event(rumor({ pubkey: "bob", kind: 7, created_at: 500 }));
      await store.event(rumor({ pubkey: "alice", kind: 1, created_at: 500 }));
      await store.event(rumor({ pubkey: "alice", kind: 7, created_at: 100 }));
      await store.event(rumor({ pubkey: "alice", kind: 7, created_at: 900 }));

      expect(await store.query([{ ids: ["wanted"] }])).toEqual([target]);
      expect(await store.query([{ authors: ["alice"], kinds: [7], since: 500, until: 500 }]))
        .toEqual([target]);
    });

    it("matches content substrings with search", async () => {
      const store = db.tenant("t");
      const hit = rumor({ content: "the quick brown fox" });
      await store.event(hit);
      await store.event(rumor({ content: "nothing here" }));

      expect(await store.query([{ search: "brown" }])).toEqual([hit]);
      expect(await store.query([{ search: "%" }])).toEqual([]);
    });

    it("returns rumors newest first, ties broken by smaller id", async () => {
      const store = db.tenant("t");
      const newest = rumor({ id: "c", created_at: 300 });
      const tieA = rumor({ id: "a", created_at: 200 });
      const tieB = rumor({ id: "b", created_at: 200 });
      for (const r of [tieB, newest, tieA]) await store.event(r);

      expect(await store.query([{}])).toEqual([newest, tieA, tieB]);
    });

    it("applies limit per filter and unions filters without duplicates", async () => {
      const store = db.tenant("t");
      const a = rumor({ id: "a", kind: 1, created_at: 300 });
      const b = rumor({ id: "b", kind: 1, created_at: 200 });
      const c = rumor({ id: "c", kind: 2, created_at: 100 });
      for (const r of [a, b, c]) await store.event(r);

      expect(await store.query([{ limit: 2 }])).toEqual([a, b]);
      // `a` matches both filters but is returned once.
      expect(await store.query([{ kinds: [1] }, { ids: ["a", "c"] }])).toEqual([a, b, c]);
    });

    it("matches nothing for an empty array constraint", async () => {
      const store = db.tenant("t");
      await store.event(rumor());

      expect(await store.query([{ kinds: [] }])).toEqual([]);
      expect(await store.query([{ authors: [] }])).toEqual([]);
    });

    it("does not index oversized tag values", async () => {
      const store = db.tenant("t");
      const long = "x".repeat(200);
      await store.event(rumor({ tags: [["blob", long]] }));

      expect(await store.query([{ "#blob": [long] }])).toEqual([]);
    });

    it("counts matching rumors", async () => {
      const store = db.tenant("t");
      await store.event(rumor({ kind: 1, tags: [["channel", "chan-1"]] }));
      await store.event(rumor({ kind: 1, tags: [["channel", "chan-1"]] }));
      await store.event(rumor({ kind: 1, tags: [["channel", "chan-2"]] }));

      expect(await store.count([{ "#channel": ["chan-1"] }])).toEqual({
        count: 2,
        approximate: false,
      });
      expect(await store.count([{ kinds: [1] }])).toEqual({ count: 3, approximate: false });
      expect(await store.count([{ kinds: [99] }])).toEqual({ count: 0, approximate: false });
    });

    it("removes matching rumors, including their tag index", async () => {
      const store = db.tenant("t");
      const keep = rumor({ kind: 1, tags: [["channel", "chan-1"]] });
      const drop = rumor({ kind: 2, tags: [["channel", "chan-1"]] });
      await store.event(keep);
      await store.event(drop);

      await store.remove([{ kinds: [2] }]);

      expect(await store.query([{}])).toEqual([keep]);
      expect(await store.query([{ "#channel": ["chan-1"] }])).toEqual([keep]);
    });

    it("never stores ephemeral kinds", async () => {
      const store = db.tenant("t");
      await store.event(rumor({ kind: 20001 }));

      expect(await store.query([{}])).toEqual([]);
    });
  });

  describe("replaceable rumors", () => {
    it("supersedes an older version at the same coordinate", async () => {
      const store = db.tenant("t");
      const old = rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 });
      const fresh = rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 });
      await store.event(old);
      await store.event(fresh);

      expect(await store.query([{ kinds: [10002] }])).toEqual([fresh]);
    });

    it("ignores a stale write", async () => {
      const store = db.tenant("t");
      const fresh = rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 });
      const old = rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 });
      await store.event(fresh);
      await store.event(old);

      expect(await store.query([{ kinds: [10002] }])).toEqual([fresh]);
    });

    it("keeps addressable versions with different d tags apart", async () => {
      const store = db.tenant("t");
      const one = rumor({ id: "one", kind: 30078, pubkey: "alice", tags: [["d", "a"]] });
      const two = rumor({ id: "two", kind: 30078, pubkey: "alice", tags: [["d", "b"]] });
      const newerA = rumor({
        id: "three",
        kind: 30078,
        pubkey: "alice",
        created_at: 9999,
        tags: [["d", "a"]],
      });
      for (const r of [one, two, newerA]) await store.event(r);

      const got = await store.query([{ kinds: [30078] }]);
      expect(got.map((r) => r.id).sort()).toEqual(["three", "two"]);
    });

    it("scopes supersession to the tenant", async () => {
      const old = rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 });
      const fresh = rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 });
      await db.tenant("a").event(old);
      await db.tenant("b").event(fresh);

      expect(await db.tenant("a").query([{}])).toEqual([old]);
      expect(await db.tenant("b").query([{}])).toEqual([fresh]);
    });
  });

  describe("NIP-09 deletion", () => {
    it("deletes the author's own rumors and keeps the request", async () => {
      const store = db.tenant("t");
      const mine = rumor({ id: "mine", pubkey: "alice", created_at: 100 });
      const theirs = rumor({ id: "theirs", pubkey: "bob", created_at: 100 });
      await store.event(mine);
      await store.event(theirs);

      const request = rumor({
        id: "req",
        kind: 5,
        pubkey: "alice",
        created_at: 200,
        tags: [
          ["e", "mine"],
          ["e", "theirs"],
        ],
      });
      await store.event(request);

      const got = await store.query([{}]);
      expect(got.map((r) => r.id).sort()).toEqual(["req", "theirs"]);
    });

    it("deletes an addressable coordinate up to the request time", async () => {
      const store = db.tenant("t");
      await store.event(
        rumor({ id: "a", kind: 30078, pubkey: "alice", created_at: 100, tags: [["d", "x"]] }),
      );
      await store.event(
        rumor({
          id: "req",
          kind: 5,
          pubkey: "alice",
          created_at: 200,
          tags: [["a", "30078:alice:x"]],
        }),
      );

      expect(await store.query([{ kinds: [30078] }])).toEqual([]);
    });
  });

  describe("kv", () => {
    it("returns undefined for a key that was never set", async () => {
      expect(await db.kv.get("missing")).toBeUndefined();
    });

    it("round-trips JSON values", async () => {
      await db.kv.set("cursor", { since: 123, relays: ["wss://a"], done: false });

      expect(await db.kv.get("cursor")).toEqual({
        since: 123,
        relays: ["wss://a"],
        done: false,
      });
    });

    it("round-trips primitives, including falsy ones", async () => {
      await db.kv.set("n", 0);
      await db.kv.set("s", "");
      await db.kv.set("b", false);
      await db.kv.set("nil", null);

      expect(await db.kv.get("n")).toBe(0);
      expect(await db.kv.get("s")).toBe("");
      expect(await db.kv.get("b")).toBe(false);
      expect(await db.kv.get("nil")).toBeNull();
    });

    it("overwrites an existing key", async () => {
      await db.kv.set("k", "first");
      await db.kv.set("k", "second");

      expect(await db.kv.get("k")).toBe("second");
    });

    it("is independent of tenant data", async () => {
      await db.kv.set("t", "kv value");
      await db.tenant("t").event(rumor());

      expect(await db.kv.get("t")).toBe("kv value");
      expect((await db.tenant("t").query([{}])).length).toBe(1);
    });
  });
});
