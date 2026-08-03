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

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";
import type { ArmadaDB } from "./types";

/** The whole driver contract, over Node's built-in SQLite. */
class NodeSqlDriver implements ArmadaSqlDriver {
  private readonly db = new DatabaseSync(":memory:");

  run(sql: string, params: SqlValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    return this.db.prepare(sql).all(...params) as SqlRow[];
  }

  close(): void {
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

    it("matches nothing for a search that names nothing it can match", async () => {
      const store = db.tenant("t");
      const a = rumor({ content: "the quick brown fox" });
      const b = rumor({ content: "nothing here" });
      await store.event(a);
      await store.event(b);

      // Neither is a keyword either adapter can honor — the first is a NIP-50
      // extension nobody implements, the second is punctuation. Dropping the
      // constraint would answer a narrowing query with the whole tenant.
      expect(await store.query([{ search: "domain:example.com" }])).toEqual([]);
      expect(await store.query([{ search: '""' }])).toEqual([]);

      // Asking for nothing constrains nothing, which is not the same thing.
      expect(await store.query([{ search: "" }])).toHaveLength(2);
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

    it("deletes a key", async () => {
      await db.kv.set("gone", "here");
      await db.kv.delete("gone");

      expect(await db.kv.get("gone")).toBeUndefined();
    });

    it("deleting a key that was never set is a no-op", async () => {
      await expect(db.kv.delete("never")).resolves.toBeUndefined();
    });

    it("lists every entry when no selector is given", async () => {
      await db.kv.set("a", 1);
      await db.kv.set("b", 2);

      const all = [{ key: "a", value: 1 }, { key: "b", value: 2 }];
      expect(await db.kv.list()).toEqual(all);
      expect(await db.kv.list({})).toEqual(all);
      expect(await db.kv.list({ prefix: "" })).toEqual(all);
    });

    it("lists a value with its key, so no follow-up read is needed", async () => {
      await db.kv.set("p:1", { since: 7 });
      await db.kv.set("p:2", null);

      expect(await db.kv.list({ prefix: "p:" })).toEqual([
        { key: "p:1", value: { since: 7 } },
        { key: "p:2", value: null },
      ]);
    });

    it("lists only the entries under a prefix", async () => {
      await db.kv.set("p:1", 1);
      await db.kv.set("p:2", 2);
      await db.kv.set("q:1", 3);

      expect(await db.kv.list({ prefix: "p:" })).toEqual([
        { key: "p:1", value: 1 },
        { key: "p:2", value: 2 },
      ]);
    });

    it("treats the prefix as a boundary, not a substring match", async () => {
      // `p` is a prefix of `pp`, so a bound that ran to the wrong successor
      // would drag `pp:1` in. It must not.
      await db.kv.set("p:1", 1);
      await db.kv.set("pp:1", 2);
      await db.kv.set("op:1", 3);

      expect(await db.kv.list({ prefix: "p:" })).toEqual([{ key: "p:1", value: 1 }]);
      expect(await db.kv.list({ prefix: "pp" })).toEqual([{ key: "pp:1", value: 2 }]);
    });

    it("lists nothing under an unmatched prefix", async () => {
      await db.kv.set("a:1", 1);

      expect(await db.kv.list({ prefix: "z:" })).toEqual([]);
    });

    it("stops listing an entry once it is deleted", async () => {
      await db.kv.set("d:1", 1);
      await db.kv.set("d:2", 2);
      await db.kv.delete("d:1");

      expect(await db.kv.list({ prefix: "d:" })).toEqual([{ key: "d:2", value: 2 }]);
    });

    it("scans a prefix ending in the maximal code unit", async () => {
      // \uffff has no successor code unit, so the range degrades to open-ended
      // and the prefix filter is the only thing keeping `x` out.
      await db.kv.set("k\uffff:1", 1);
      await db.kv.set("x", 2);

      expect(await db.kv.list({ prefix: "k\uffff" })).toEqual([{ key: "k\uffff:1", value: 1 }]);
    });

    it("scans a half-open range", async () => {
      for (const key of ["a", "b", "c", "d"]) await db.kv.set(key, key);

      // `start` inclusive, `end` exclusive.
      expect(await db.kv.list({ start: "b", end: "d" })).toEqual([
        { key: "b", value: "b" },
        { key: "c", value: "c" },
      ]);
      expect(await db.kv.list({ start: "c" })).toEqual([
        { key: "c", value: "c" },
        { key: "d", value: "d" },
      ]);
      expect(await db.kv.list({ end: "b" })).toEqual([{ key: "a", value: "a" }]);
    });

    it("resumes a prefix scan from a cursor", async () => {
      // The reason ranges exist here: a key space with an ordered suffix can be
      // read forward from where the last pass stopped.
      for (const n of [1, 2, 3, 4]) await db.kv.set(`log:${n}`, n);

      expect(await db.kv.list({ prefix: "log:", start: "log:3" })).toEqual([
        { key: "log:3", value: 3 },
        { key: "log:4", value: 4 },
      ]);
      expect(await db.kv.list({ prefix: "log:", end: "log:3" })).toEqual([
        { key: "log:1", value: 1 },
        { key: "log:2", value: 2 },
      ]);
    });

    it("keeps a range bound inside its prefix", async () => {
      await db.kv.set("p:1", 1);
      await db.kv.set("q:1", 2);

      // A bound outside the prefix narrows to nothing rather than escaping it:
      // `q:` is past the end of `p:`, and `a` is before its start.
      expect(await db.kv.list({ prefix: "p:", start: "q:" })).toEqual([]);
      expect(await db.kv.list({ prefix: "p:", end: "a" })).toEqual([]);
      expect(await db.kv.list({ prefix: "p:", start: "a" })).toEqual([{ key: "p:1", value: 1 }]);
    });

    it("lists nothing when the bounds cross", async () => {
      await db.kv.set("b", 1);

      expect(await db.kv.list({ start: "z", end: "a" })).toEqual([]);
      expect(await db.kv.list({ start: "b", end: "b" })).toEqual([]);
    });

    it("refuses a prefix given both bounds", async () => {
      // The bounds already describe the range; a prefix on top of them is either
      // redundant or a contradiction, and Deno.KV rejects the same shape.
      await expect(db.kv.list({ prefix: "p:", start: "p:1", end: "p:9" })).rejects.toThrow(TypeError);
    });

    it("takes the first entries under a limit", async () => {
      for (const n of [1, 2, 3]) await db.kv.set(`p:${n}`, n);

      expect(await db.kv.list({ prefix: "p:" }, { limit: 2 })).toEqual([
        { key: "p:1", value: 1 },
        { key: "p:2", value: 2 },
      ]);
      // A limit past the end is not an error, and 0 asks for nothing.
      expect((await db.kv.list({ prefix: "p:" }, { limit: 9 })).length).toBe(3);
      expect(await db.kv.list({ prefix: "p:" }, { limit: 0 })).toEqual([]);
    });

    it("walks the key order backwards", async () => {
      for (const n of [1, 2, 3]) await db.kv.set(`p:${n}`, n);

      expect((await db.kv.list({ prefix: "p:" }, { reverse: true })).map((e) => e.key))
        .toEqual(["p:3", "p:2", "p:1"]);
      // A limit takes from the front of the order it was asked for, so reversing
      // makes it the LAST entries.
      expect(await db.kv.list({ prefix: "p:" }, { reverse: true, limit: 1 })).toEqual([
        { key: "p:3", value: 3 },
      ]);
    });

    it("limits a scan whose range over-admits", async () => {
      // An open-ended prefix scan (see above) reads past its own matches, so the
      // limit cannot be handed to the engine — it has to apply to what SURVIVES
      // the filter, or a full page would come back short.
      await db.kv.set("k\uffff:1", 1);
      await db.kv.set("k\uffff:2", 2);
      await db.kv.set("x", 3);

      expect(await db.kv.list({ prefix: "k\uffff" }, { limit: 2 })).toEqual([
        { key: "k\uffff:1", value: 1 },
        { key: "k\uffff:2", value: 2 },
      ]);
    });
  });
});
