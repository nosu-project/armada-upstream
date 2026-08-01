/**
 * The fold snapshot cache's write notification.
 *
 * The wire builds its subscription spec from PERSISTED folds, not a live one,
 * and its query key moves only on a new community, a rotated epoch, or a
 * channel-count change. A control edition that alters none of those — attaching
 * a repository, renaming a channel — would otherwise leave the spec stale until
 * its own two-minute poll, so the write itself has to be observable.
 */

import { openDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";

import { purgeArmadaDB } from "@/lib/db/armadaDB";

import {
  __resetFoldedForTests,
  LEGACY_FOLDED_DB_NAME,
  onFoldedWrite,
  readFolded,
  writeFolded,
} from "./foldedCache";

// The store is ArmadaDB's KV, reached through a module-level singleton, so a
// fresh `IDBFactory` per test would strand the already-open connection. Purge
// instead.
afterEach(async () => {
  await purgeArmadaDB();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(LEGACY_FOLDED_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  __resetFoldedForTests();
});

describe("onFoldedWrite", () => {
  it("notifies subscribers with the written key, and stops after unsubscribe", async () => {
    const seen: string[] = [];
    const unsubscribe = onFoldedWrite((key) => seen.push(key));

    await writeFolded("concord2-fold:abc", { channels: [] });
    expect(seen).toEqual(["concord2-fold:abc"]);
    // The value is still readable — notification is not a substitute for the write.
    await expect(readFolded("concord2-fold:abc")).resolves.toEqual({ channels: [] });

    unsubscribe();
    await writeFolded("concord2-fold:def", { channels: [] });
    expect(seen).toEqual(["concord2-fold:abc"]);
  });

  it("a throwing subscriber never breaks the write or its siblings", async () => {
    const seen: string[] = [];
    const unsubThrower = onFoldedWrite(() => {
      throw new Error("subscriber blew up");
    });
    const unsubGood = onFoldedWrite((key) => seen.push(key));

    await expect(writeFolded("concord2-fold:xyz", { ok: true })).resolves.toBeUndefined();
    await expect(readFolded("concord2-fold:xyz")).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["concord2-fold:xyz"]);

    unsubThrower();
    unsubGood();
  });
});

describe("readFolded / writeFolded", () => {
  it("returns undefined for a key that was never written", async () => {
    await expect(readFolded("concord2-fold:absent")).resolves.toBeUndefined();
  });

  it("round-trips the shapes JSON drops", async () => {
    await writeFolded("fold:shapes", {
      epoch: 42n,
      key: new Uint8Array([0, 1, 254, 255]),
      members: new Map([["alice", 1]]),
      admins: new Set(["bob"]),
    });

    expect(await readFolded("fold:shapes")).toEqual({
      epoch: 42n,
      key: new Uint8Array([0, 1, 254, 255]),
      members: new Map([["alice", 1]]),
      admins: new Set(["bob"]),
    });
  });

  it("keeps null distinct from a miss, and undefined indistinguishable from one", async () => {
    // `useCommunityImageDescriptors` writes `icon ?? null` and relies on null
    // coming back as null rather than as "not cached".
    await writeFolded("fold:null", null);
    await writeFolded("fold:undef", undefined);

    expect(await readFolded("fold:null")).toBeNull();
    expect(await readFolded("fold:undef")).toBeUndefined();
  });

  it("does not collide with another subsystem's KV keys", async () => {
    const { getArmadaDB } = await import("@/lib/db/armadaDB");
    await getArmadaDB().kv.set("provenance:x", "not a fold");
    await writeFolded("provenance:x", { mine: true });

    expect(await getArmadaDB().kv.get("provenance:x")).toBe("not a fold");
    expect(await readFolded("provenance:x")).toEqual({ mine: true });
  });
});

describe("migrateLegacyFolded", () => {
  /** Seed the pre-ArmadaDB database with an already-encoded value. */
  async function seedLegacy(key: string, encoded: string): Promise<void> {
    const legacy = await openDB(LEGACY_FOLDED_DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore("kv");
      },
    });
    await legacy.put("kv", encoded, key);
    legacy.close();
  }

  it("drains on first read, tagged values included", async () => {
    await seedLegacy("fold:old", '{"epoch":{"__t":"bigint","v":"7"}}');

    expect(await readFolded("fold:old")).toEqual({ epoch: 7n });
  });

  it("a write cannot be clobbered by a later drain", async () => {
    // The drain has not run yet, and the legacy database holds an older value
    // for the same key. The write must win.
    await seedLegacy("fold:raced", '{"stale":true}');
    await writeFolded("fold:raced", { stale: false });

    expect(await readFolded("fold:raced")).toEqual({ stale: false });
  });
});
