// @vitest-environment node
/**
 * The IndexedDB → native store move.
 *
 * What matters here is what is at stake: the source holds decrypted Concord and
 * NIP-17 history that exists nowhere else once the relays drop the wraps that
 * carried it. So the assertions are about the ordering that protects it —
 * nothing is deleted until everything is copied, the KV goes first (every other
 * drain's completion flag lives in it), and a failure leaves the source intact
 * for the next launch.
 */
import { DatabaseSync } from "node:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";

/** A stand-in for the native store: the TypeScript SQLite adapter behind it. */
const native = vi.hoisted(() => {
  const state: { store?: unknown; failWrites: boolean } = { failWrites: false };

  const store = () =>
    state.store as {
      tenant(id: string): {
        query(filters: unknown[]): Promise<NostrRumor[]>;
        event(rumor: NostrRumor): Promise<void>;
      };
      kv: {
        get<T>(key: string): Promise<T | undefined>;
        set<T>(key: string, value: T): Promise<void>;
        keys(prefix?: string): Promise<string[]>;
      };
    };

  return {
    state,
    plugin: {
      async query({ tenant, filters }: { tenant: string; filters: string }) {
        return { rumors: JSON.stringify(await store().tenant(tenant).query(JSON.parse(filters))) };
      },
      async event({ tenant, rumors }: { tenant: string; rumors: string }) {
        if (state.failWrites) throw new Error("bridge is down");
        const batch = JSON.parse(rumors) as NostrRumor[];
        await Promise.all(batch.map((rumor) => store().tenant(tenant).event(rumor)));
      },
      async count() {
        return { count: 0, approximate: false };
      },
      async remove() {},
      async tenants() {
        return { tenants: "[]" };
      },
      async kvGet({ key }: { key: string }) {
        const value = await store().kv.get<string>(key);
        return value === undefined ? {} : { value };
      },
      async kvSet({ key, value }: { key: string; value: string }) {
        await store().kv.set(key, value);
      },
      async kvDelete() {},
      async kvKeys({ prefix }: { prefix?: string }) {
        return { keys: JSON.stringify(await store().kv.keys(prefix)) };
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

const rumor = (id: string, created_at = 1000): NostrRumor => ({
  id,
  pubkey: "pk",
  kind: 1,
  created_at,
  content: "",
  tags: [["channel", "c1"]],
});

/** Database names present at the origin, via the factory's own bookkeeping. */
async function databaseNames(): Promise<string[]> {
  return (await (indexedDB as IDBFactory).databases())
    .flatMap((d) => (d.name ? [d.name] : []))
    .sort();
}

/** A fresh module graph, so the singletons and the memoised drain start unset. */
async function newSession() {
  vi.resetModules();
  const { SqliteArmadaDB } = await import("./SqliteArmadaDB");
  native.state.store = new SqliteArmadaDB(new NodeSqlDriver());
  native.state.failWrites = false;
  return {
    armadaDB: await import("./armadaDB"),
    migration: await import("./nativeDbMigration"),
  };
}

describe("nativeDbMigration", () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it("is pending while an IndexedDB store is present, and not after", async () => {
    const { armadaDB, migration } = await newSession();
    // Seed the IndexedDB adapter, as a pre-upgrade install would have.
    await armadaDB.openIndexedDBArmadaDB().tenant("c2:abc").event(rumor("a"));

    expect(await migration.nativeDbMigrationPending()).toBe(true);

    await migration.migrateToNativeDb();

    // The flag is on the native side, so it survives a relaunch — and so does
    // the answer, since the databases it was asking about are gone.
    expect(await migration.nativeDbMigrationPending()).toBe(false);
  });

  it("is not pending on a fresh install", async () => {
    const { migration } = await newSession();
    expect(await migration.nativeDbMigrationPending()).toBe(false);
  });

  it("copies rumors into the matching native tenant", async () => {
    const { armadaDB, migration } = await newSession();
    const source = armadaDB.openIndexedDBArmadaDB();
    await source.tenant("c2:abc").event(rumor("a", 100));
    await source.tenant("c2:abc").event(rumor("b", 200));
    await source.tenant("dm17:alice").event(rumor("c", 300));

    await migration.migrateToNativeDb();

    const db = armadaDB.getArmadaDB();
    expect((await db.tenant("c2:abc").query([{ "#channel": ["c1"] }])).map((r) => r.id))
      .toEqual(["b", "a"]);
    expect((await db.tenant("dm17:alice").query([{}])).map((r) => r.id)).toEqual(["c"]);
  });

  it("copies the KV, which is what stops every legacy drain re-running", async () => {
    const { armadaDB, migration } = await newSession();
    await armadaDB.openIndexedDBArmadaDB().kv.set("migrations:complete", true);

    await migration.migrateToNativeDb();

    expect(await armadaDB.getArmadaDB().kv.get("migrations:complete")).toBe(true);
  });

  it("deletes the IndexedDB databases once everything is copied", async () => {
    const { armadaDB, migration } = await newSession();
    await armadaDB.openIndexedDBArmadaDB().tenant("c2:abc").event(rumor("a"));
    expect(await databaseNames()).not.toEqual([]);

    await migration.migrateToNativeDb();

    expect(await databaseNames()).toEqual([]);
  });

  it("deletes nothing when the copy fails", async () => {
    const { armadaDB, migration } = await newSession();
    await armadaDB.openIndexedDBArmadaDB().tenant("c2:abc").event(rumor("a"));
    const before = await databaseNames();

    native.state.failWrites = true;
    await expect(migration.migrateToNativeDb()).rejects.toThrow();

    expect(await databaseNames()).toEqual(before);
    expect(await armadaDB.getArmadaDB().kv.get("nativedb:migrated")).toBeUndefined();
  });

  it("does not put a stale value back over one written since a partial run", async () => {
    const { armadaDB, migration } = await newSession();
    await armadaDB.openIndexedDBArmadaDB().kv.set("cursor", 1);
    // The native store already holds a newer value, as it would after the app
    // ran against it between a failed attempt and this one.
    await armadaDB.getArmadaDB().kv.set("cursor", 2);

    await migration.migrateToNativeDb();

    expect(await armadaDB.getArmadaDB().kv.get("cursor")).toBe(2);
  });
});
