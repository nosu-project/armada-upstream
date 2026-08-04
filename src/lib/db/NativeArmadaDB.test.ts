// @vitest-environment node
/**
 * The Android bridge adapter, against a stand-in for the native store.
 *
 * What is under test here is the TRANSPORT, not the query engine: the engine is
 * Kotlin, and `ArmadaDbTest.kt` runs the conformance suite against it directly.
 * What can go wrong on this side is everything around it — a filter that doesn't
 * survive `JSON.stringify`, a burst that crosses the bridge a thousand times
 * instead of once, a KV value that comes back as a string.
 *
 * The stand-in is the TypeScript SQLite adapter, which is the same design and
 * the same schema, so a protocol mismatch shows up as a wrong answer rather than
 * as a passing test against a mock that agrees with whatever it was handed.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";

/**
 * A stand-in for `ArmadaDbPlugin.kt`, speaking the same JSON-text protocol.
 * Hoisted because `vi.mock`'s factory runs before the module body.
 */
const native = vi.hoisted(() => {
  const calls = { query: 0, event: 0, count: 0, remove: 0, kvSet: 0, kvOps: 0 };
  let store: {
    tenant(id: string): {
      query(filters: NostrFilter[]): Promise<NostrRumor[]>;
      event(rumor: NostrRumor): Promise<void>;
      count(filters: NostrFilter[]): Promise<{ count: number; approximate: boolean }>;
      remove(filters: NostrFilter[]): Promise<void>;
    };
    kv: {
      get<T>(key: string): Promise<T | undefined>;
      set<T>(key: string, value: T): Promise<void>;
      delete(key: string): Promise<void>;
      list<T>(
        selector?: { prefix?: string; start?: string; end?: string },
        opts?: { limit?: number; reverse?: boolean },
      ): Promise<{ key: string; value: T }[]>;
    };
  };

  return {
    calls,
    use(next: typeof store) {
      store = next;
      for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
    },
    plugin: {
      async query({ tenant, filters }: { tenant: string; filters: string }) {
        calls.query++;
        const rumors = await store.tenant(tenant).query(JSON.parse(filters) as NostrFilter[]);
        return { rumors: JSON.stringify(rumors) };
      },
      async event({ tenant, rumors }: { tenant: string; rumors: string }) {
        calls.event++;
        const batch = JSON.parse(rumors) as NostrRumor[];
        await Promise.all(batch.map((rumor) => store.tenant(tenant).event(rumor)));
      },
      async count({ tenant, filters }: { tenant: string; filters: string }) {
        calls.count++;
        return await store.tenant(tenant).count(JSON.parse(filters) as NostrFilter[]);
      },
      async remove({ tenant, filters }: { tenant: string; filters: string }) {
        calls.remove++;
        await store.tenant(tenant).remove(JSON.parse(filters) as NostrFilter[]);
      },
      async tenants() {
        return { tenants: JSON.stringify([]) };
      },
      // The native side stores opaque JSON TEXT, so the stand-in has to as
      // well: a stub that kept the live value would hide a serialization bug.
      async kvGet({ key }: { key: string }) {
        const value = await store.kv.get<string>(key);
        return value === undefined ? {} : { value };
      },
      async kvSet({ key, value }: { key: string; value: string }) {
        calls.kvSet++;
        await store.kv.set(key, value);
      },
      async kvDelete({ key }: { key: string }) {
        await store.kv.delete(key);
      },
      async kvList(
        { prefix, start, end, limit, reverse }: {
          prefix?: string;
          start?: string;
          end?: string;
          limit?: number;
          reverse?: boolean;
        },
      ) {
        // Values cross as the JSON TEXT they are stored as, which for this
        // stand-in means the string the backing store handed back.
        const entries = await store.kv.list<string>({ prefix, start, end }, { limit, reverse });
        return { entries: JSON.stringify(entries) };
      },
      // The batched KV crossing (see `NativeKV.flush`): ops in arrival order,
      // results aligned positionally, values still opaque JSON TEXT.
      async kvOps({ ops }: { ops: string }) {
        calls.kvOps++;
        const batch = JSON.parse(ops) as Array<
          | { op: "get"; key: string }
          | { op: "set"; key: string; value: string }
          | { op: "delete"; key: string }
          | { op: "list"; prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean }
        >;
        const results: Array<string | null | Array<{ key: string; value: string }>> = [];
        for (const op of batch) {
          if (op.op === "get") {
            const value = await store.kv.get<string>(op.key);
            results.push(value === undefined ? null : value);
          } else if (op.op === "set") {
            calls.kvSet++;
            await store.kv.set(op.key, op.value);
            results.push(null);
          } else if (op.op === "delete") {
            await store.kv.delete(op.key);
            results.push(null);
          } else {
            const { prefix, start, end, limit, reverse } = op;
            results.push(await store.kv.list<string>({ prefix, start, end }, { limit, reverse }));
          }
        }
        return { results: JSON.stringify(results) };
      },
      async wipe() {},
    },
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isPluginAvailable: () => true,
    isNativePlatform: () => true,
  },
  registerPlugin: () => native.plugin,
}));

const { hasNativeArmadaDB, NativeArmadaDB } = await import("./NativeArmadaDB");
const { SqliteArmadaDB } = await import("./SqliteArmadaDB");

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

describe("NativeArmadaDB", () => {
  let backing: InstanceType<typeof SqliteArmadaDB>;
  let db: InstanceType<typeof NativeArmadaDB>;

  beforeEach(() => {
    backing = new SqliteArmadaDB(new NodeSqlDriver());
    native.use(backing);
    db = new NativeArmadaDB();
  });

  afterEach(async () => {
    await backing.close().catch(() => undefined);
  });

  it("is selected on Android when the plugin is present", () => {
    expect(hasNativeArmadaDB()).toBe(true);
  });

  it("returns the same store for a tenant id", () => {
    expect(db.tenant("c2:abc")).toBe(db.tenant("c2:abc"));
  });

  it("stores and reads back a rumor", async () => {
    const r = rumor({ tags: [["channel", "chan-1"]] });
    await db.tenant("c2:abc").event(r);

    expect(await db.tenant("c2:abc").query([{ "#channel": ["chan-1"] }])).toEqual([r]);
  });

  it("isolates tenants", async () => {
    await db.tenant("a").event(rumor({ id: "a" }));
    await db.tenant("b").event(rumor({ id: "b" }));

    expect((await db.tenant("a").query([{}])).map((r) => r.id)).toEqual(["a"]);
    expect((await db.tenant("b").query([{}])).map((r) => r.id)).toEqual(["b"]);
  });

  it("strips a signature before it crosses the bridge", async () => {
    const signed = { ...rumor({ id: "a" }), sig: "f".repeat(128) };
    await db.tenant("t").event(signed);

    const [stored] = await db.tenant("t").query([{}]);
    expect(stored).not.toHaveProperty("sig");
  });

  it("crosses the bridge ONCE for a burst of writes", async () => {
    await Promise.all([
      db.tenant("t").event(rumor({ id: "a" })),
      db.tenant("t").event(rumor({ id: "b" })),
      db.tenant("t").event(rumor({ id: "c" })),
    ]);

    expect(native.calls.event).toBe(1);
    expect((await db.tenant("t").query([{}])).length).toBe(3);
  });

  it("carries every filter term across", async () => {
    await db.tenant("t").event(rumor({ id: "a", pubkey: "alice", kind: 1, created_at: 100 }));
    await db.tenant("t").event(rumor({ id: "b", pubkey: "bob", kind: 7, created_at: 200 }));

    expect((await db.tenant("t").query([{ ids: ["b"] }])).map((r) => r.id)).toEqual(["b"]);
    expect((await db.tenant("t").query([{ authors: ["alice"] }])).map((r) => r.id)).toEqual(["a"]);
    expect((await db.tenant("t").query([{ kinds: [7] }])).map((r) => r.id)).toEqual(["b"]);
    expect((await db.tenant("t").query([{ since: 200 }])).map((r) => r.id)).toEqual(["b"]);
    expect((await db.tenant("t").query([{ until: 100 }])).map((r) => r.id)).toEqual(["a"]);
    expect((await db.tenant("t").query([{ limit: 1 }])).map((r) => r.id)).toEqual(["b"]);
  });

  it("counts and removes", async () => {
    await db.tenant("t").event(rumor({ id: "a", kind: 1 }));
    await db.tenant("t").event(rumor({ id: "b", kind: 7 }));

    expect(await db.tenant("t").count([{}])).toEqual({ count: 2, approximate: false });

    await db.tenant("t").remove([{ kinds: [7] }]);
    expect((await db.tenant("t").query([{}])).map((r) => r.id)).toEqual(["a"]);
  });

  it("round-trips kv values through JSON, not through the bridge's guesses", async () => {
    await db.kv.set("obj", { a: 1, b: ["x"] });
    await db.kv.set("num", 0);
    await db.kv.set("bool", false);
    await db.kv.set("str", "");

    expect(await db.kv.get("obj")).toEqual({ a: 1, b: ["x"] });
    expect(await db.kv.get("num")).toBe(0);
    expect(await db.kv.get("bool")).toBe(false);
    expect(await db.kv.get("str")).toBe("");
    expect(await db.kv.get("missing")).toBeUndefined();
  });

  it("normalizes an out-of-contract value to null rather than throwing", async () => {
    await db.kv.set("undef", undefined);
    expect(await db.kv.get("undef")).toBeNull();
  });

  it("deletes and prefix-scans kv entries", async () => {
    await db.kv.set("a:1", 1);
    await db.kv.set("a:2", 2);
    await db.kv.set("b:1", 3);

    // Values come back with the keys, having crossed the bridge as JSON text.
    expect(await db.kv.list({ prefix: "a:" })).toEqual([
      { key: "a:1", value: 1 },
      { key: "a:2", value: 2 },
    ]);

    await db.kv.delete("a:1");
    expect(await db.kv.list({ prefix: "a:" })).toEqual([{ key: "a:2", value: 2 }]);
    // Deleting a key that was never set is a no-op, not an error.
    await db.kv.delete("a:1");
  });

  it("carries a range selector across the bridge", async () => {
    for (const n of [1, 2, 3, 4]) await db.kv.set(`log:${n}`, n);

    expect(await db.kv.list({ prefix: "log:", start: "log:3" })).toEqual([
      { key: "log:3", value: 3 },
      { key: "log:4", value: 4 },
    ]);
    expect(await db.kv.list({ prefix: "log:" }, { reverse: true, limit: 1 })).toEqual([
      { key: "log:4", value: 4 },
    ]);
  });

  it("coalesces a same-tick kv burst into one crossing, in arrival order", async () => {
    // A burst issued before anyone awaits — every op crosses the bridge ONCE,
    // and the list at the end observes every write queued ahead of it.
    const [, , got, listed] = await Promise.all([
      db.kv.set("burst:1", 1),
      db.kv.set("burst:2", 2),
      db.kv.get("burst:1"),
      db.kv.list({ prefix: "burst:" }),
    ]);

    expect(native.calls.kvOps).toBe(1);
    expect(got).toBe(1);
    expect(listed).toEqual([
      { key: "burst:1", value: 1 },
      { key: "burst:2", value: 2 },
    ]);
  });
});
