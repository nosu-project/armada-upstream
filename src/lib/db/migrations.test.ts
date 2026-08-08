// @vitest-environment node
/**
 * The migration catalogue's load-bearing rules:
 *
 *  - a per-account drain runs for EVERY logged-in account before the shared
 *    database behind it is deleted,
 *  - nothing is deleted at all if a drain failed OR could not yet run, and
 *  - the schema version only advances over data that actually made it across.
 *
 * The first three exist because the legacy databases are the only copy of data
 * that cannot be refetched. Getting any of them wrong destroys it silently —
 * "resolved" is the signal to delete, so a drain that copies nothing and
 * resolves is indistinguishable from one that copied everything.
 */
import { NIndexedDB } from "@nostrify/indexeddb";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MigrationsModule = typeof import("./migrations");

const A = "a".repeat(64);
const B = "b".repeat(64);

/** Database names present at the origin. */
async function databaseNames(): Promise<string[]> {
  const dbs = await (indexedDB as IDBFactory).databases();
  return dbs.flatMap((d) => (d.name ? [d.name] : [])).sort();
}

/** A fresh module graph, so module-level drain memos don't leak between tests. */
async function freshModules(): Promise<MigrationsModule> {
  vi.resetModules();
  return await import("./migrations");
}

// Each case drives every drain in the catalogue against a real (fake-indexeddb)
// origin, which is well past the default 5s budget when the whole suite is
// competing for the CPU.
describe("runMigrations", { timeout: 30_000 }, () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it("drains every account before deleting the database they shared", async () => {
    // One global DM database with a message for each of two logged-in accounts.
    const legacy = new NIndexedDB("armada-dm17-rumors");
    for (const [self, peer] of [[A, "peer-a"], [B, "peer-b"]] as const) {
      await legacy.event({
        id: `rumor-${self.slice(0, 4)}`,
        kind: 14,
        content: "hello",
        created_at: 1000,
        pubkey: self,
        tags: [["p", "someone"], ["peer", peer]],
        sig: "",
      });
    }
    await legacy.close();

    const { runMigrations } = await freshModules();
    await runMigrations([A, B]);

    // Deleted only because BOTH accounts took their share out first.
    expect(await databaseNames()).not.toContain("armada-dm17-rumors");

    const { dm17Store } = await import("@/lib/nip17/dm17Store");
    expect((await dm17Store(A).query([{ kinds: [14] }])).length).toBe(1);
    expect((await dm17Store(B).query([{ kinds: [14] }])).length).toBe(1);
  });

  it("deletes nothing when a drain throws", async () => {
    const mod = await freshModules();
    const original = mod.MIGRATIONS[0].run;
    mod.MIGRATIONS[0].run = () => Promise.reject(new Error("disk on fire"));
    try {
      // Give the origin a database to lose, so "deleted nothing" is meaningful.
      const legacy = new NIndexedDB("armada-concord-invites");
      await legacy.event({
        id: "invite",
        kind: 3313,
        content: "{}",
        created_at: 1,
        pubkey: "sender",
        tags: [["p", A]],
        sig: "",
      });
      await legacy.close();

      await mod.runMigrations([A]);

      expect(await databaseNames()).toContain("armada-concord-invites");
    } finally {
      mod.MIGRATIONS[0].run = original;
    }
  });

  it("reports nothing pending once the databases are gone", async () => {
    const { pendingLegacyDatabases, runMigrations } = await freshModules();
    await runMigrations([A]);
    expect(await pendingLegacyDatabases()).toEqual([]);
  });

  it("deletes nothing when a drain copies nothing and resolves", async () => {
    // The failure mode the "throws" case above cannot see: a drain that
    // swallows its own error resolves, and a resolved drain is the catalogue's
    // signal that the source is safe to delete.
    const mod = await freshModules();
    const original = mod.MIGRATIONS[0].run;
    mod.MIGRATIONS[0].run = () => Promise.resolve();
    try {
      const legacy = new NIndexedDB("armada-concord-cache");
      await legacy.event({
        id: "row",
        kind: 1,
        content: "",
        created_at: 1,
        pubkey: A,
        tags: [],
        sig: "",
      });
      await legacy.close();

      await mod.runMigrations([A]);
      // Resolved, so it IS deleted — which is exactly why a drain must not
      // resolve without having copied. The rest of this file pins the drains
      // that could previously do so.
      expect(await databaseNames()).not.toContain("armada-concord-cache");
    } finally {
      mod.MIGRATIONS[0].run = original;
    }
  });

  it("keeps the Concord store when the account's community list isn't cached", async () => {
    // Community rows carry no community id — attribution needs the cached,
    // decrypted list, and without it the drain can claim nothing. Resolving
    // anyway would delete a history that is frequently only on this device.
    const legacy = new NIndexedDB("armada-concord-rumors");
    await legacy.event({
      id: "c".repeat(64),
      kind: 9,
      content: "hello",
      created_at: 1000,
      pubkey: A,
      tags: [["channel", "d".repeat(64)]],
      sig: "",
    });
    await legacy.close();

    const { runMigrations } = await freshModules();
    await runMigrations([A]);

    expect(await databaseNames()).toContain("armada-concord-rumors");
    const { getArmadaDB } = await import("./armadaDB");
    expect(await getArmadaDB().kv.get(`c2rumors:migrated:${A}`)).toBeUndefined();
  });

  it("drains the Concord store when the cached list says the account has left", async () => {
    // A cached but EMPTY list is an answer, unlike no cached list: nothing in
    // the store is attributable, so there is nothing to lose by deleting it.
    const legacy = new NIndexedDB("armada-concord-rumors");
    await legacy.event({
      id: "c".repeat(64),
      kind: 9,
      content: "orphan",
      created_at: 1000,
      pubkey: A,
      tags: [["channel", "d".repeat(64)]],
      sig: "",
    });
    await legacy.close();

    const mod = await freshModules();
    const { writeFolded } = await import("@/lib/foldedCache");
    const { communityListFoldKey } = await import("@/concord/lib/communityList");
    await writeFolded(communityListFoldKey(A), { event: null, list: { entries: [] } });

    await mod.runMigrations([A]);

    expect(await databaseNames()).not.toContain("armada-concord-rumors");
  });
});

describe("schema version", { timeout: 30_000 }, () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it("stamps the current version after a clean run", async () => {
    const { runMigrations } = await freshModules();
    await runMigrations([A]);

    const { getArmadaDB } = await import("./armadaDB");
    const { ARMADA_DB_VERSION, SCHEMA_VERSION_KEY } = await import("./schema");
    expect(await getArmadaDB().kv.get(SCHEMA_VERSION_KEY)).toBe(ARMADA_DB_VERSION);
  });

  it("leaves the version unstamped when a drain failed", async () => {
    // The stamp says "this data is in the current shape". Data still sitting
    // in an undrained database is not, and a schema migration written later
    // would skip right over it.
    const mod = await freshModules();
    const original = mod.MIGRATIONS[0].run;
    mod.MIGRATIONS[0].run = () => Promise.reject(new Error("disk on fire"));
    try {
      await mod.runMigrations([A]);
      const { getArmadaDB } = await import("./armadaDB");
      const { SCHEMA_VERSION_KEY } = await import("./schema");
      expect(await getArmadaDB().kv.get(SCHEMA_VERSION_KEY)).toBeUndefined();
    } finally {
      mod.MIGRATIONS[0].run = original;
    }
  });

  it("leaves data written by a newer build alone", async () => {
    const mod = await freshModules();
    const { getArmadaDB } = await import("./armadaDB");
    const { SCHEMA_VERSION_KEY } = await import("./schema");
    await getArmadaDB().kv.set(SCHEMA_VERSION_KEY, 999);

    const legacy = new NIndexedDB("armada-concord-invites");
    await legacy.event({
      id: "invite",
      kind: 3313,
      content: "{}",
      created_at: 1,
      pubkey: "sender",
      tags: [["p", A]],
      sig: "",
    });
    await legacy.close();

    await mod.runMigrations([A]);

    // No conversion here was written against that shape, so nothing runs and
    // the marker is never walked backwards.
    expect(await getArmadaDB().kv.get(SCHEMA_VERSION_KEY)).toBe(999);
    expect(await databaseNames()).toContain("armada-concord-invites");
  });

  it("marks a fresh install up to date without creating legacy databases", async () => {
    // A drain that opens a legacy database CREATES it, so an install with
    // nothing to migrate would manufacture the very database the gate scans
    // for and show a storage-upgrade overlay on its second launch, forever.
    const { markUpToDate, pendingUpgrades, legacyDatabaseNames } = await freshModules();

    const pending = await pendingUpgrades();
    expect(pending.legacy).toEqual([]);
    expect(pending.schema).toEqual([]);
    expect(pending.future).toBe(false);

    await markUpToDate();

    // Now exercise the lazy drain paths the app hits during an ordinary session.
    const { readFolded } = await import("@/lib/foldedCache");
    const { queryDm17Conversations } = await import("@/lib/nip17/dm17Store");
    const { queryStoredInvites } = await import("@/concord/lib/inviteInbox");
    await readFolded("anything");
    await queryDm17Conversations(A);
    await queryStoredInvites(A);

    const names = await databaseNames();
    expect(names.filter((n) => legacyDatabaseNames().includes(n))).toEqual([]);
  });
});

/**
 * The localStorage key spaces that moved into KV.
 *
 * This is the ONLY thing that copies them: the caches in front of those
 * prefixes read KV and nothing else, so a value this misses is a value the app
 * can no longer see. The rule that matters is that the localStorage copy is
 * never dropped before the KV copy is confirmed readable — one of these key
 * spaces holds unsent message drafts.
 */
describe("the localStorage move", { timeout: 30_000 }, () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  it("copies each moved prefix into KV and removes the old keys", async () => {
    localStorage.setItem("chat-draft:relay|group", JSON.stringify({ content: "unsent" }));
    localStorage.setItem("armada:relay-info:wss://r.example", JSON.stringify({ name: "r" }));
    localStorage.setItem("unrelated:key", "left alone");

    const { runMigrations } = await freshModules();
    await runMigrations([A]);

    const { getArmadaDB } = await import("./armadaDB");
    const kv = getArmadaDB().kv;
    // Under the id the CACHE reads with — no legacy prefix on the front. Get
    // this wrong and every migrated value is stored where nothing looks.
    expect(await kv.get("draft:relay|group")).toEqual({ content: "unsent" });
    expect(await kv.get("relay-info:wss://r.example")).toEqual({ name: "r" });

    expect(localStorage.getItem("chat-draft:relay|group")).toBeNull();
    expect(localStorage.getItem("unrelated:key")).toBe("left alone");
  });

  it("serves a moved value through the cache that owns the prefix", async () => {
    localStorage.setItem("chat-draft:room", JSON.stringify({ content: "unsent" }));

    const { runMigrations } = await freshModules();
    await runMigrations([A]);

    const { KvPrefixCache } = await import("./kvCache");
    const cache = new KvPrefixCache<{ content: string }>({ prefix: "draft:" });
    await cache.ready();
    expect(cache.get("room")).toEqual({ content: "unsent" });
  });

  it("keeps the localStorage copy when KV cannot store it", async () => {
    // KV degrades to a silent no-op where IndexedDB is unavailable (iOS
    // Lockdown Mode, some private-browsing contexts). Dropping the only other
    // copy on the strength of an unverified write loses the data outright.
    localStorage.setItem("chat-draft:room", JSON.stringify({ content: "unsent" }));

    const { runMigrations } = await freshModules();
    const { getArmadaDB } = await import("./armadaDB");
    vi.spyOn(getArmadaDB().kv, "set").mockResolvedValue(undefined);

    await runMigrations([A]);

    expect(localStorage.getItem("chat-draft:room")).not.toBeNull();
  });

  it("tolerates a legacy value that was a bare string", async () => {
    // Older builds stored the draft text directly rather than a JSON object.
    localStorage.setItem("chat-draft:room", "just text");

    const { runMigrations } = await freshModules();
    await runMigrations([A]);

    const { getArmadaDB } = await import("./armadaDB");
    expect(await getArmadaDB().kv.get("draft:room")).toBe("just text");
  });

  it("does not overwrite a value this session already wrote to KV", async () => {
    // The app writes through to KV from the first frame, so a value written
    // since boot is newer than the localStorage copy being walked.
    localStorage.setItem("chat-draft:room", JSON.stringify({ content: "stale" }));

    const { runMigrations } = await freshModules();
    const { getArmadaDB } = await import("./armadaDB");
    await getArmadaDB().kv.set("draft:room", { content: "typed just now" });

    await runMigrations([A]);

    expect(await getArmadaDB().kv.get("draft:room")).toEqual({ content: "typed just now" });
    expect(localStorage.getItem("chat-draft:room")).toBeNull();
  });

  it("is not pending once the keys are gone", async () => {
    localStorage.setItem("chat-draft:room", JSON.stringify({ content: "unsent" }));

    const mod = await freshModules();
    expect((await mod.pendingUpgrades()).schema.map((m) => m.to)).toEqual([2]);

    await mod.runMigrations([A]);
    expect((await mod.pendingUpgrades()).schema).toEqual([]);
  });
});

/**
 * Version 3: NIP-29 leaves `main` for a tenant per relay.
 *
 * Nothing is MOVED, and that is the point — these are exactly the rows whose
 * source relay was never recorded, which is why they had to leave. There is no
 * honest tenant to move them to, and inventing one would re-file another
 * server's channel under this one. What the sweep must not do is take anything
 * with them: `main` still holds the global kinds, including the kind-5 deletes,
 * reactions and comments that only LOOK like NIP-29 traffic.
 */
describe("the NIP-29 relay-tenant split", { timeout: 30_000 }, () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    localStorage.clear();
  });

  /**
   * A fresh module graph, then the ArmadaDB singleton bound to THIS test's
   * origin. Order matters: `armadaDB.ts` memoizes its instance, so seeding
   * through a graph carried over from an earlier test would write into that
   * test's (already replaced) IDBFactory and the migration would run against an
   * empty origin.
   */
  async function freshDb() {
    const mod = await freshModules();
    const { getArmadaDB } = await import("./armadaDB");
    return { ...mod, db: getArmadaDB() };
  }

  /** Seed `main` the way the pre-split build did: everything in one tenant. */
  async function seedMain(
    db: Awaited<ReturnType<typeof freshDb>>["db"],
    events: Array<{ id: string; kind: number; tags?: string[][] }>,
  ) {
    const main = db.tenant("main");
    for (const e of events) {
      await main.event({
        id: e.id.padEnd(64, "0").slice(0, 64),
        pubkey: A,
        created_at: 1_000,
        kind: e.kind,
        tags: e.tags ?? [],
        content: "",
      });
    }
  }

  async function mainIds(db: Awaited<ReturnType<typeof freshDb>>["db"]): Promise<string[]> {
    const rows = await db.tenant("main").query([{ limit: 100 }]);
    return rows.map((r) => r.id.replace(/0+$/, "")).sort();
  }

  it("reclaims orphaned group-scoped rows and keeps the global ones", async () => {
    const { runMigrations, db } = await freshDb();
    await seedMain(db, [
      { id: "chat", kind: 9, tags: [["h", "general"]] },
      { id: "meta", kind: 39000, tags: [["d", "general"]] },
      { id: "modq", kind: 9000, tags: [["h", "general"]] },
      { id: "gdel", kind: 5, tags: [["h", "general"], ["e", "x"]] },
      // Must SURVIVE: same kinds, no group scope.
      { id: "prof", kind: 0 },
      { id: "note", kind: 1 },
      { id: "del", kind: 5, tags: [["e", "x"]] },
      { id: "react", kind: 7, tags: [["e", "x"]] },
      { id: "list", kind: 10009 },
    ]);

    await runMigrations([A]);

    expect(await mainIds(db)).toEqual(["del", "list", "note", "prof", "react"]);
  });

  it("drops the provenance KV space the relay tenants replace", async () => {
    const { runMigrations, db } = await freshDb();
    await db.kv.set("provenance:wss://r.example\u0000000001\u0000abc", 1);
    await db.kv.set("provenance:migrated", true);
    await db.kv.set("draft:keep", { content: "mine" });

    await runMigrations([A]);

    expect(await db.kv.list({ prefix: "provenance:" })).toEqual([]);
    expect(await db.kv.get("draft:keep")).toEqual({ content: "mine" });
  });

  it("stamps the version and leaves a fresh install untouched", async () => {
    const { runMigrations, db } = await freshDb();
    await runMigrations([A]);

    const { ARMADA_DB_VERSION, SCHEMA_VERSION_KEY } = await import("./schema");
    expect(await db.kv.get(SCHEMA_VERSION_KEY)).toBe(ARMADA_DB_VERSION);
    expect(await mainIds(db)).toEqual([]);
  });
});
