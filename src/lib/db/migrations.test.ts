// @vitest-environment node
/**
 * The migration catalogue's two load-bearing rules:
 *
 *  - a per-account drain runs for EVERY logged-in account before the shared
 *    database behind it is deleted, and
 *  - nothing is deleted at all if a drain failed.
 *
 * Both exist because the legacy databases are the only copy of data that
 * cannot be refetched. Getting either wrong destroys it silently.
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

describe("runMigrations", () => {
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
});
