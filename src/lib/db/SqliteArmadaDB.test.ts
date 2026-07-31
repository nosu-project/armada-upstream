// @vitest-environment node
/**
 * SQLite-specific tests: the parts of the adapter the shared conformance suite
 * (ArmadaDB.test.ts) can't see — the time-encoded rowid, the token index the
 * planner drives tag queries off, its paged and split scans, the NIP-50 search
 * paths, and the invariant that no index row (token, coordinate or full-text)
 * outlives the rumor it describes.
 */
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteArmadaDB } from "./SqliteArmadaDB";

import type { SqliteArmadaDBOpts } from "./SqliteArmadaDB";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";

/** A driver that also records the SELECTs it ran, so plans can be inspected. */
class RecordingDriver implements ArmadaSqlDriver {
  readonly db = new DatabaseSync(":memory:");
  readonly selects: Array<{ sql: string; params: SqlValue[] }> = [];

  run(sql: string, params: SqlValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    if (sql.startsWith("SELECT")) this.selects.push({ sql, params });
    return this.db.prepare(sql).all(...params) as SqlRow[];
  }

  close(): void {
    this.db.close();
  }

  /** The `EXPLAIN QUERY PLAN` detail lines for every recorded SELECT. */
  plans(): string[] {
    return this.selects.flatMap(({ sql, params }) => {
      const rows = this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      return (rows as Array<{ detail: string }>).map((row) => row.detail);
    });
  }
}

const drivers: RecordingDriver[] = [];

function makeDb(opts: SqliteArmadaDBOpts = {}): { db: SqliteArmadaDB; driver: RecordingDriver } {
  const driver = new RecordingDriver();
  drivers.push(driver);
  return { db: new SqliteArmadaDB(driver, opts), driver };
}

afterEach(() => {
  for (const driver of drivers.splice(0)) {
    try {
      driver.close();
    } catch {
      // already closed
    }
  }
});

let seq = 0;

function rumor(partial: Partial<NostrRumor> = {}): NostrRumor {
  seq++;
  return {
    id: partial.id ?? `id-${String(seq).padStart(6, "0")}`,
    pubkey: "pk-default",
    kind: 1,
    created_at: 1000 + seq,
    content: "",
    tags: [],
    ...partial,
  };
}

/** Rows straight out of the tables, bypassing the store. */
function rows(driver: RecordingDriver, sql: string): SqlRow[] {
  return driver.db.prepare(sql).all() as SqlRow[];
}

describe("SqliteArmadaDB — rowid encoding", () => {
  it("stores rumors at a rowid that orders by created_at", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ id: "older", created_at: 100 }));
    await db.tenant("t").event(rumor({ id: "newer", created_at: 200 }));

    const stored = rows(driver, "SELECT id, seq, created_at FROM rumors ORDER BY seq");

    expect(stored.map((row) => row.id)).toEqual(["older", "newer"]);
    // created_at × 2²⁰, so a scan of the table IS a scan by time.
    expect(stored.map((row) => Number(row.seq))).toEqual([100 * 2 ** 20, 200 * 2 ** 20]);
  });

  it("gives rumors sharing a timestamp adjacent rowids", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    await store.event(rumor({ id: "a", created_at: 100 }));
    await store.event(rumor({ id: "b", created_at: 100 }));

    expect(rows(driver, "SELECT seq FROM rumors ORDER BY seq").map((row) => Number(row.seq)))
      .toEqual([100 * 2 ** 20, 100 * 2 ** 20 + 1]);
  });

  it("keeps time bounds exact for timestamps the encoding must clamp", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    // Beyond 2106, so every such rumor lands in the same clamped bucket and
    // only the `created_at` re-check can tell them apart.
    const early = rumor({ id: "early", created_at: 0x100000000 });
    const late = rumor({ id: "late", created_at: 0x200000000 });
    await store.event(early);
    await store.event(late);

    expect(await store.query([{ since: 0x180000000 }])).toEqual([late]);
    expect(await store.query([{ until: 0x180000000 }])).toEqual([early]);
  });
});

describe("SqliteArmadaDB — query plans", () => {
  it("drives a tag query off the token index, never scanning rumors", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ tags: [["channel", "c1"]] }));

    driver.selects.length = 0;
    await db.tenant("t").query([{ "#channel": ["c1"], kinds: [1] }]);

    const plans = driver.plans();
    expect(plans.some((detail) => detail.includes("rumor_tags_fts"))).toBe(true);
    // The rumors table is reached by rowid, one seek per match.
    expect(plans.some((detail) => /SCAN r\b/.test(detail))).toBe(false);
  });

  it("keeps the index driving when conditions are left for the rumors table", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    await store.event(rumor({ kind: 1, content: "treasure map", tags: [["channel", "c1"]] }));

    for (const filters of [
      [{ "#channel": ["c1"], kinds: [1], limit: 10 }],
      [{ search: "treasure", limit: 10 }],
    ]) {
      driver.selects.length = 0;
      await store.query(filters);

      const plans = driver.plans();
      // Left to itself, SQLite drives from `rumors` and probes the FTS index
      // once per row — which re-runs the MATCH per probe and sorts the result.
      // Measured at 20k rumors, that is ~2900× slower, so the join order is
      // forced and this is what checks it stayed forced.
      expect(plans.some((detail) => /SCAN (rumor_tags_fts|rumors_fts)/.test(detail))).toBe(true);
      expect(plans.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
      expect(plans.some((detail) => /SEARCH r USING/.test(detail) && !detail.includes("INTEGER PRIMARY KEY")))
        .toBe(false);
    }
  });

  it("answers several tag terms with one index lookup", async () => {
    const { db, driver } = makeDb();
    const both = rumor({ tags: [["channel", "c1"], ["reply", "r1"]] });
    await db.tenant("t").event(both);
    await db.tenant("t").event(rumor({ tags: [["channel", "c1"]] }));

    driver.selects.length = 0;
    expect(await db.tenant("t").query([{ "#channel": ["c1"], "#reply": ["r1"] }])).toEqual([both]);

    // One statement, one MATCH — the terms are intersected inside FTS5 rather
    // than by driving on one and filtering by the other.
    expect(driver.selects).toHaveLength(1);
    expect(driver.selects[0].params[0]).toBe('"t:channel:c1" AND "t:reply:r1"');
  });

  it("folds an author constraint into the same match as the tags", async () => {
    const { db, driver } = makeDb();
    const mine = rumor({ pubkey: "alice", tags: [["channel", "c1"]] });
    await db.tenant("t").event(mine);
    await db.tenant("t").event(rumor({ pubkey: "bob", tags: [["channel", "c1"]] }));

    driver.selects.length = 0;
    expect(await db.tenant("t").query([{ "#channel": ["c1"], authors: ["alice"] }])).toEqual([mine]);

    expect(driver.selects).toHaveLength(1);
    expect(driver.selects[0].params[0]).toBe('"t:channel:c1" AND "t:_p:alice"');
  });

  it("scopes tokens to their tenant", async () => {
    const { db, driver } = makeDb();
    await db.tenant("a").event(rumor({ pubkey: "alice", tags: [["channel", "c1"]] }));

    expect(rows(driver, "SELECT rowid FROM rumor_tags_fts")).toHaveLength(1);
    // The tenant leads every token, so no posting list is ever shared between
    // two tenants — a query never walks past its own namespace.
    expect(
      rows(driver, `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"a:channel:c1"'`),
    ).toHaveLength(1);
    expect(
      rows(driver, `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"b:channel:c1"'`),
    ).toHaveLength(0);
  });

  it("hashes a tenant id too long to spell out in every token", async () => {
    const { db, driver } = makeDb();
    const tenant = `c2:${"ab".repeat(32)}`;
    const hit = rumor({ tags: [["channel", "c1"]] });
    await db.tenant(tenant).event(hit);

    // Hex-escaping a 67-character id would put 135 characters in front of
    // every token, so the prefix is a truncated hash instead — `_` plus 16 hex
    // characters, a form no verbatim id can take.
    const prefix = `_${bytesToHex(sha256(utf8ToBytes(tenant)).slice(0, 8))}`;
    expect(prefix).toMatch(/^_[0-9a-f]{16}$/);
    expect(
      rows(
        driver,
        `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"${prefix}:channel:c1"'`,
      ),
    ).toHaveLength(1);

    expect(await db.tenant(tenant).query([{ "#channel": ["c1"] }])).toEqual([hit]);
  });

  it("escapes a tag value the tokenizer would otherwise split or fold", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = rumor({ tags: [["subject", "Hello, World!"]] });
    await store.event(hit);
    await store.event(rumor({ tags: [["subject", "hello"]] }));

    // A verbatim token would be split on the punctuation and folded to
    // lowercase, so `hello` would match both.
    expect(await store.query([{ "#subject": ["Hello, World!"] }])).toEqual([hit]);
    expect(await store.query([{ "#subject": ["hello, world!"] }])).toEqual([]);
  });

  it("forces the pubkey+kind index for an authors+kinds query", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ pubkey: "alice", kind: 7 }));

    driver.selects.length = 0;
    await db.tenant("t").query([{ authors: ["alice"], kinds: [7] }]);

    expect(driver.plans().some((detail) => detail.includes("rumors_pubkey_kind"))).toBe(true);
  });

  it("forces the tenant index for an unconstrained query", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor());

    driver.selects.length = 0;
    await db.tenant("t").query([{ limit: 10 }]);

    expect(driver.plans().some((detail) => detail.includes("rumors_tenant"))).toBe(true);
  });

  it("reads a single covered scan without a second key lookup", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ kind: 1 }));

    driver.selects.length = 0;
    await db.tenant("t").query([{ kinds: [1], limit: 5 }]);

    // One statement, and it reads the bodies inline.
    expect(driver.selects).toHaveLength(1);
    expect(driver.selects[0].sql).toContain("SELECT json FROM rumors INDEXED BY rumors_kind");
  });
});

describe("SqliteArmadaDB — scans", () => {
  it("pages a scan whose conditions discard rows", async () => {
    const { db } = makeDb();

    // The content index carries no tenant, so a keyword-driven scan finds
    // another tenant's rows and has to discard them — a page can come back
    // short of the limit, and the scan must keep going.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 600; i++) {
      const store = db.tenant(i % 2 === 0 ? "mine" : "theirs");
      writes.push(store.event(rumor({ content: `shared word ${i}` })));
    }
    await Promise.all(writes);

    const got = await db.tenant("mine").query([{ search: "shared" }]);

    expect(got).toHaveLength(300);
    expect(new Set(got.map((r) => r.id)).size).toBe(300);
    expect(got[0].created_at).toBeGreaterThan(got[got.length - 1].created_at);
  });

  it("pages a scan that SQL can't fully express", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    // More kinds than are worth binding (MAX_PUSHDOWN), so the token scan
    // can't carry them and they post-filter in memory, paging by rowid.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 600; i++) {
      writes.push(store.event(rumor({ kind: i % 2 === 0 ? 1 : 7, tags: [["channel", "c1"]] })));
    }
    await Promise.all(writes);

    const kinds = [1, ...Array.from({ length: 200 }, (_, i) => 1000 + i)];
    const got = await store.query([{ "#channel": ["c1"], kinds }]);

    expect(got).toHaveLength(300);
    expect(got.every((r) => r.kind === 1)).toBe(true);
    expect(new Set(got.map((r) => r.id)).size).toBe(300);
    expect(got[0].created_at).toBeGreaterThan(got[got.length - 1].created_at);
  });

  it("merges a scan split across statements by a long kind list", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    // One kind in each half of the split, plus one outside the list entirely.
    const wanted = [rumor({ kind: 1 }), rumor({ kind: 600 })];
    await store.event(rumor({ kind: 900 }));
    await Promise.all(wanted.map((r) => store.event(r)));

    // 600 kinds > MAX_IN, so the scan runs as two statements and is merged.
    const kinds = Array.from({ length: 600 }, (_, i) => i + 1);
    const got = await store.query([{ kinds }]);

    expect(got.map((r) => r.id).sort()).toEqual(wanted.map((r) => r.id).sort());
  });

  it("merges a match split across statements by a long tag value list", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    // One value in each half of the split.
    const wanted = [
      rumor({ tags: [["channel", "c1"]] }),
      rumor({ tags: [["channel", "c600"]] }),
    ];
    await store.event(rumor({ tags: [["channel", "c900"]] }));
    await Promise.all(wanted.map((r) => store.event(r)));

    // 600 values > MAX_OR, so the MATCH is split into two and merged.
    const values = Array.from({ length: 600 }, (_, i) => `c${i + 1}`);
    const got = await store.query([{ "#channel": values }]);

    expect(got.map((r) => r.id).sort()).toEqual(wanted.map((r) => r.id).sort());
  });

  it("honors a limit on a tag scan", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        store.event(rumor({ created_at: 5000 + i, tags: [["channel", "c1"]] }))),
    );

    driver.selects.length = 0;
    const got = await store.query([{ "#channel": ["c1"], limit: 10 }]);

    expect(got).toHaveLength(10);
    expect(got[0].created_at).toBe(5049);
    // The whole filter is in the index, so the limit is too: one statement,
    // ten rows read.
    expect(driver.selects).toHaveLength(1);
  });
});

describe("SqliteArmadaDB — search", () => {
  it("matches keywords case- and accent-insensitively", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = rumor({ content: "Ahoy Matelot" });
    await store.event(hit);
    await store.event(rumor({ content: "nothing here" }));

    expect(await store.query([{ search: "ahoy" }])).toEqual([hit]);
    expect(await store.query([{ search: "MATELOT" }])).toEqual([hit]);
    expect(await store.query([{ search: "matelôt" }])).toEqual([hit]);
  });

  it("requires every keyword and honors negation", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const both = rumor({ content: "red boat" });
    await store.event(both);
    await store.event(rumor({ content: "red anchor" }));

    expect(await store.query([{ search: "red boat" }])).toEqual([both]);
    expect(await store.query([{ search: "red -anchor" }])).toEqual([both]);
    expect(await store.query([{ search: "red boat anchor" }])).toEqual([]);
  });

  it("combines search with other constraints", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = rumor({ kind: 1, pubkey: "alice", content: "treasure map" });
    await store.event(hit);
    await store.event(rumor({ kind: 1, pubkey: "bob", content: "treasure map" }));

    expect(await store.query([{ search: "treasure", authors: ["alice"] }])).toEqual([hit]);
    expect(await store.query([{ search: "treasure", kinds: [7] }])).toEqual([]);
  });

  it("intersects keywords with a tag-driven scan", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");
    const hit = rumor({ content: "treasure map", tags: [["channel", "c1"]] });
    await store.event(hit);
    await store.event(rumor({ content: "treasure map", tags: [["channel", "c2"]] }));
    await store.event(rumor({ content: "nothing here", tags: [["channel", "c1"]] }));

    expect(await store.query([{ search: "treasure", "#channel": ["c1"] }])).toEqual([hit]);
  });

  it("keeps search results inside their tenant", async () => {
    const { db } = makeDb();
    const mine = rumor({ content: "shared word" });
    await db.tenant("a").event(mine);
    await db.tenant("b").event(rumor({ content: "shared word" }));

    expect(await db.tenant("a").query([{ search: "shared" }])).toEqual([mine]);
  });

  it("counts matches without reading rumor bodies", async () => {
    const { db } = makeDb();
    const store = db.tenant("t");

    await Promise.all(
      Array.from({ length: 1100 }, (_, i) =>
        store.event(rumor({ created_at: 5000 + i, content: `common message ${i}` }))),
    );
    await store.event(rumor({ created_at: 9999, content: "unrelated" }));

    const got = await store.query([{ search: "common", limit: 5 }]);

    expect(got).toHaveLength(5);
    expect(got.every((r) => r.content.includes("common"))).toBe(true);
    expect(await store.count([{ search: "common" }])).toEqual({
      count: 1100,
      approximate: false,
    });
  });

  it("still matches keywords with the index turned off", async () => {
    const { db, driver } = makeDb({ search: false });
    const store = db.tenant("t");
    const hit = rumor({ content: "the quick brown fox" });
    await store.event(hit);
    await store.event(rumor({ content: "nothing here" }));

    expect(await store.query([{ search: "BROWN" }])).toEqual([hit]);
    expect(await store.query([{ search: "quick -fox" }])).toEqual([]);
    // Tags stay queryable — only the content index is optional.
    expect(rows(driver, "SELECT name FROM sqlite_master WHERE name = 'rumors_fts'")).toHaveLength(0);
    expect(
      rows(driver, "SELECT name FROM sqlite_master WHERE name = 'rumor_tags_fts'"),
    ).toHaveLength(1);
  });

  it("stops finding a rumor once it is removed", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    await store.event(rumor({ content: "ephemeral phrase" }));

    await store.remove([{ search: "ephemeral" }]);

    expect(await store.query([{ search: "ephemeral" }])).toEqual([]);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(0);
  });
});

describe("SqliteArmadaDB — index upkeep", () => {
  it("leaves no token or coordinate rows behind when a version is superseded", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await store.event(
      rumor({
        id: "v1",
        kind: 30078,
        pubkey: "alice",
        created_at: 100,
        tags: [["d", "x"], ["channel", "c1"]],
      }),
    );
    await store.event(
      rumor({
        id: "v2",
        kind: 30078,
        pubkey: "alice",
        created_at: 200,
        tags: [["d", "x"], ["channel", "c2"]],
      }),
    );

    expect(rows(driver, "SELECT id FROM rumors").map((r) => r.id)).toEqual(["v2"]);
    expect(rows(driver, "SELECT rowid FROM rumor_tags_fts")).toHaveLength(1);
    expect(
      rows(driver, `SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH '"t:channel:c1"'`),
    ).toHaveLength(0);
    expect(rows(driver, "SELECT coord, id FROM rumor_coords")).toEqual([
      { coord: "30078:alice:x", id: "v2" },
    ]);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(1);
  });

  it("leaves no rows behind when a rumor is removed", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await store.event(
      rumor({ id: "gone", kind: 10002, pubkey: "alice", tags: [["channel", "c1"]] }),
    );
    await store.remove([{ ids: ["gone"] }]);

    expect(rows(driver, "SELECT id FROM rumors")).toHaveLength(0);
    expect(rows(driver, "SELECT rowid FROM rumor_tags_fts")).toHaveLength(0);
    expect(rows(driver, "SELECT coord FROM rumor_coords")).toHaveLength(0);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(0);
  });

  it("does not free a coordinate a stale write failed to take", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    await store.event(rumor({ id: "new", kind: 10002, pubkey: "alice", created_at: 200 }));
    await store.event(rumor({ id: "old", kind: 10002, pubkey: "alice", created_at: 100 }));

    expect(rows(driver, "SELECT id FROM rumors").map((r) => r.id)).toEqual(["new"]);
    expect(rows(driver, "SELECT id FROM rumor_coords").map((r) => r.id)).toEqual(["new"]);
  });

  it("indexes a re-delivered rumor exactly once", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");
    const again = rumor({ id: "twice", tags: [["channel", "c1"]] });

    await store.event(again);
    await store.event({ ...again });

    expect(rows(driver, "SELECT id FROM rumors")).toHaveLength(1);
    expect(rows(driver, "SELECT rowid FROM rumor_tags_fts")).toHaveLength(1);
    expect(rows(driver, "SELECT rowid FROM rumors_fts")).toHaveLength(1);
  });

  it("commits a burst of writes as one transaction", async () => {
    const { db, driver } = makeDb();
    const store = db.tenant("t");

    const writes = [store.event(rumor()), store.event(rumor()), store.event(rumor())];
    driver.selects.length = 0;
    await Promise.all(writes);

    expect(rows(driver, "SELECT id FROM rumors")).toHaveLength(3);
  });

  it("wipes every table", async () => {
    const { db, driver } = makeDb();
    await db.tenant("t").event(rumor({ kind: 10002, tags: [["channel", "c1"]] }));
    await db.kv.set("cursor", 1);

    await db.wipe();

    for (const table of ["rumors", "rumor_coords", "kv"]) {
      expect(rows(driver, `SELECT * FROM ${table}`)).toHaveLength(0);
    }
    for (const table of ["rumor_tags_fts", "rumors_fts"]) {
      expect(rows(driver, `SELECT rowid FROM ${table}`)).toHaveLength(0);
    }
  });

  it("rejects a write whose transaction fails", async () => {
    const { db, driver } = makeDb();
    driver.close();

    await expect(db.tenant("t").event(rumor())).rejects.toThrow();
  });
});
