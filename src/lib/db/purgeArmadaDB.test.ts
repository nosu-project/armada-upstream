// @vitest-environment node
/**
 * The app-wide instance and its logout purge.
 *
 * The behaviour under test is the one that isn't obvious: tenant database
 * names are dynamic, so a purge can't just know them. It reads a durable
 * registry the adapter writes on every `tenant()` — which is what makes the
 * purge correct on Firefox, where `indexedDB.databases()` does not exist and
 * nothing can be enumerated.
 */
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";

import type { NostrRumor } from "@/lib/nostrRumor";

type ArmadaDBModule = typeof import("./armadaDB");

const rumor = (id: string): NostrRumor => ({
  id,
  pubkey: "pk",
  kind: 1,
  created_at: 1000,
  content: "",
  tags: [],
});

/**
 * A fresh import of the module, so its lazy singleton starts unset — a page
 * reload, or an app relaunch. The IndexedDB data itself is untouched.
 */
async function newSession(): Promise<ArmadaDBModule> {
  vi.resetModules();
  return await import("./armadaDB");
}

/** Database names present at the origin, via the factory's own bookkeeping. */
async function databaseNames(): Promise<string[]> {
  const dbs = await (indexedDB as IDBFactory).databases();
  return dbs.flatMap((d) => (d.name ? [d.name] : [])).sort();
}

/** Hide `indexedDB.databases()` for the duration of `fn` (the Firefox case). */
async function withoutEnumeration<T>(fn: () => Promise<T>): Promise<T> {
  const factory = indexedDB as IDBFactory;
  const real = factory.databases;
  (factory as { databases?: unknown }).databases = undefined;
  try {
    return await fn();
  } finally {
    factory.databases = real;
  }
}

describe("purgeArmadaDB", () => {
  beforeEach(() => {
    // A fresh origin per test: no database survives into the next one.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it("deletes tenant databases with no way to enumerate them", async () => {
    const { ARMADA_DB_NAME, getArmadaDB, purgeArmadaDB } = await newSession();
    const db = getArmadaDB();
    await db.tenant("dm17:alice").event(rumor("a"));
    await db.tenant("c2:beef").event(rumor("b"));
    await db.kv.set("cursor", 7);

    expect(await databaseNames()).toEqual([
      `${ARMADA_DB_NAME}:kv`,
      IndexedDBArmadaDB.databaseName(ARMADA_DB_NAME, "c2:beef"),
      IndexedDBArmadaDB.databaseName(ARMADA_DB_NAME, "dm17:alice"),
    ]);

    await withoutEnumeration(() => purgeArmadaDB());

    expect(await databaseNames()).toEqual([]);
  });

  it("deletes tenants recorded by an earlier session it never opened", async () => {
    const first = await newSession();
    await first.getArmadaDB().tenant("c2:cafe").event(rumor("a"));
    await (first.getArmadaDB() as IndexedDBArmadaDB).close();

    // This session never calls `tenant()`, so only the durable registry knows
    // that `armada:t:c2:cafe` exists.
    const second = await newSession();
    await withoutEnumeration(() => second.purgeArmadaDB());

    expect(await databaseNames()).toEqual([]);
  });

  it("registers a tenant that was opened but never written to", async () => {
    const first = await newSession();
    first.getArmadaDB().tenant("c2:empty");
    // Let the fire-and-forget registry write commit before the session ends.
    await first.getArmadaDB().kv.set("flush", true);
    await (first.getArmadaDB() as IndexedDBArmadaDB).close();

    const second = await newSession();
    expect(await (second.getArmadaDB() as IndexedDBArmadaDB).tenantIds()).toEqual(["c2:empty"]);
  });

  it("leaves an empty registry behind, so the next purge finds nothing", async () => {
    const first = await newSession();
    first.getArmadaDB().tenant("c2:cafe");
    await withoutEnumeration(() => first.purgeArmadaDB());

    const second = await newSession();
    expect(await (second.getArmadaDB() as IndexedDBArmadaDB).tenantIds()).toEqual([]);
  });
});
