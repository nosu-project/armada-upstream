/**
 * The fold snapshot cache's write notification.
 *
 * The wire builds its subscription spec from PERSISTED folds, not a live one,
 * and its query key moves only on a new community, a rotated epoch, or a
 * channel-count change. A control edition that alters none of those — attaching
 * a repository, renaming a channel — would otherwise leave the spec stale until
 * its own two-minute poll, so the write itself has to be observable.
 */

import { afterEach, describe, expect, it } from "vitest";

import { purgeArmadaDB } from "@/lib/db/armadaDB";

import {
  onFoldedWrite,
  readFolded,
  writeFolded,
} from "./foldedCache";

// The store is ArmadaDB's KV, reached through a module-level singleton, so a
// fresh `IDBFactory` per test would strand the already-open connection. Purge
// instead.
afterEach(async () => {
  await purgeArmadaDB();
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
