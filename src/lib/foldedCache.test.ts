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
import { __resetLegacyMigrationsMemoForTests } from "@/lib/db/legacyDatabases";

import {
  __resetFoldedForTests,
  clearFoldedMemory,
  LEGACY_FOLDED_DB_NAME,
  onFoldedWrite,
  readFolded,
  readFoldedShared,
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
  // The purge wipes `migrations:complete`, so the drain's shared "already done"
  // memo must go with it.
  __resetLegacyMigrationsMemoForTests();
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

describe("identical writes", () => {
  it("skips a write whose content the key already holds: no KV write, no notification", async () => {
    const seen: string[] = [];
    const unsubscribe = onFoldedWrite((key) => seen.push(key));
    await writeFolded("concord2-fold:abc", { channels: [1] });
    await writeFolded("concord2-fold:abc", { channels: [1] });
    await Promise.all([
      writeFolded("concord2-fold:abc", { channels: [1] }),
      writeFolded("concord2-fold:abc", { channels: [1] }),
    ]);
    expect(seen).toEqual(["concord2-fold:abc"]);
    unsubscribe();
  });

  it("still writes a changed value, and treats what a read returned as already held", async () => {
    const seen: string[] = [];
    const unsubscribe = onFoldedWrite((key) => seen.push(key));
    await writeFolded("k", { v: 1 });
    await writeFolded("k", { v: 2 });
    await expect(readFolded("k")).resolves.toEqual({ v: 2 });
    __resetFoldedForTests();
    // A fresh session that READ the value doesn't write it back.
    await readFolded("k");
    await writeFolded("k", { v: 2 });
    expect(seen).toEqual(["k", "k"]);
    unsubscribe();
  });
});

describe("readFoldedShared", () => {
  it("hands every reader one decoded object until the key is written", async () => {
    await writeFolded("concord2-fold:x", { roster: new Map([["a", 1]]) });
    __resetFoldedForTests(); // a fresh session: nothing cached yet
    const first = await readFoldedShared<{ roster: Map<string, number> }>("concord2-fold:x");
    const second = await readFoldedShared<{ roster: Map<string, number> }>("concord2-fold:x");
    expect(first).toBe(second);
    expect(first?.roster.get("a")).toBe(1);

    const next = { roster: new Map([["b", 2]]) };
    await writeFolded("concord2-fold:x", next);
    await expect(readFoldedShared("concord2-fold:x")).resolves.toBe(next);
  });

  it("clearFoldedMemory drops shared values, so a purged store reads as empty", async () => {
    await writeFolded("concord2-list:me", { entries: [1] });
    await expect(readFoldedShared("concord2-list:me")).resolves.toEqual({ entries: [1] });
    await purgeArmadaDB();
    clearFoldedMemory();
    await expect(readFoldedShared("concord2-list:me")).resolves.toBeUndefined();
    // …and the next account's identical write is a real write, not skipped.
    const seen: string[] = [];
    const unsubscribe = onFoldedWrite((key) => seen.push(key));
    await writeFolded("concord2-list:me", { entries: [1] });
    expect(seen).toEqual(["concord2-list:me"]);
    await expect(readFolded("concord2-list:me")).resolves.toEqual({ entries: [1] });
    unsubscribe();
  });

  it("remembers a missing key until it is written", async () => {
    await expect(readFoldedShared("concord2-cursor:none")).resolves.toBeUndefined();
    await expect(readFoldedShared("concord2-cursor:none")).resolves.toBeUndefined();
    await writeFolded("concord2-cursor:none", { newest: 5 });
    await expect(readFoldedShared("concord2-cursor:none")).resolves.toEqual({ newest: 5 });
  });

  it("plain reads still decode a fresh object each time", async () => {
    await writeFolded("k2", { v: [1] });
    const a = await readFolded("k2");
    const b = await readFolded("k2");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
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

  it("revives a tagged value at the ROOT, and tags nested inside Map/Set", async () => {
    // rekey.ts persists a bare Uint8Array, so the root IS the tagged object.
    await writeFolded("fold:root-u8", new Uint8Array([7, 8, 9]));
    expect(await readFolded("fold:root-u8")).toEqual(new Uint8Array([7, 8, 9]));
    await writeFolded("fold:root-epoch", 9n);
    expect(await readFolded("fold:root-epoch")).toBe(9n);

    // Children revive before their wrapper, so keys, values and members may
    // themselves be tagged, to any depth.
    await writeFolded("fold:nested", {
      byKey: new Map([[new Uint8Array([1, 2]), { epoch: 5n, seen: new Set([3n]) }]]),
      deep: [new Map([["a", new Map([["b", new Uint8Array([255])]])]])],
    });
    expect(await readFolded("fold:nested")).toEqual({
      byKey: new Map([[new Uint8Array([1, 2]), { epoch: 5n, seen: new Set([3n]) }]]),
      deep: [new Map([["a", new Map([["b", new Uint8Array([255])]])]])],
    });
  });

  it("an unknown tag decodes to the plain object, and __proto__ stays inert", async () => {
    const { getArmadaDB } = await import("@/lib/db/armadaDB");

    // A newer build's snapshot reads as data rather than throwing.
    await getArmadaDB().kv.set("folded:fold:unknown-tag", '{"a":{"__t":"quantity","v":"1"},"b":2}');
    expect(await readFolded("fold:unknown-tag")).toEqual({ a: { __t: "quantity", v: "1" }, b: 2 });

    // The fold keeps metadata extensions verbatim, so a `__proto__` KEY can reach
    // the snapshot. Reviving in place must not let it re-point a prototype.
    await getArmadaDB().kv.set(
      "folded:fold:proto",
      '{"meta":{"__proto__":{"polluted":true},"name":"ok"},"epoch":{"__t":"bigint","v":"1"}}',
    );
    const decoded = await readFolded<{ meta: { name: string }; epoch: bigint }>("fold:proto");
    expect(decoded?.meta.name).toBe("ok");
    expect(decoded?.epoch).toBe(1n);
    expect(Object.getPrototypeOf(decoded?.meta)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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
