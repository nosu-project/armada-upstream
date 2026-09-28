import { beforeEach, describe, expect, it } from "vitest";

import {
  addReadCutPending,
  clearReadCutPending,
  readCutPending,
  readCutPendingReady,
} from "@/concord/lib/readCutPending";
import { resetKvCaches } from "@/lib/db/kvCache";

const ME = "me".padEnd(64, "0");
const CID = "cid".padEnd(64, "0");
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);

describe("readCutPending", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips targets + keep, and empties to undefined", async () => {
    expect(readCutPending(ME, CID)).toBeUndefined();
    await addReadCutPending(ME, CID, A, [B, C]);
    expect(readCutPending(ME, CID)).toEqual({ targets: [A], keep: [B, C] });
    clearReadCutPending(ME, CID);
    expect(readCutPending(ME, CID)).toBeUndefined();
  });

  it("never keeps a target in the keep-list (the persisted keep drives the retry's recipients)", async () => {
    // Ban A keeping {B, C}; then ban B keeping {C} — B must leave the keep set.
    await addReadCutPending(ME, CID, A, [B, C]);
    await addReadCutPending(ME, CID, B, [C]);
    const pending = readCutPending(ME, CID)!;
    expect(new Set(pending.targets)).toEqual(new Set([A, B]));
    expect(pending.keep).not.toContain(A);
    expect(pending.keep).not.toContain(B);
    expect(pending.keep).toContain(C);
  });

  it("is scoped per (account, community)", async () => {
    await addReadCutPending(ME, CID, A, [B]);
    expect(readCutPending("other".padEnd(64, "0"), CID)).toBeUndefined();
    expect(readCutPending(ME, "other".padEnd(64, "0"))).toBeUndefined();
  });

  it("merges into an intent still on its way in from KV, rather than replacing it", async () => {
    // The failure the await exists for: a second ban issued before the cache
    // warmed used to read "nothing owed" and write only its own target,
    // dropping the read-cut the first ban had persisted.
    const cid = "cold".padEnd(64, "0");
    const { getArmadaDB } = await import("@/lib/db/armadaDB");
    await getArmadaDB().kv.set(`read-cut-pending:${ME}:${cid}`, { targets: [A], keep: [B, C] });

    // A cold cache: exactly the state a fresh launch is in.
    resetKvCaches();
    expect(readCutPending(ME, cid)).toBeUndefined();

    await addReadCutPending(ME, cid, B, [C]);

    const pending = readCutPending(ME, cid)!;
    expect(new Set(pending.targets)).toEqual(new Set([A, B]));
    expect(pending.keep).toEqual([C]);
  });

  it("ignores a malformed stored value", async () => {
    const wrong = "wrong".padEnd(64, "0");
    const { getArmadaDB } = await import("@/lib/db/armadaDB");
    await getArmadaDB().kv.set(`read-cut-pending:${ME}:${wrong}`, { targets: "x", keep: [] });
    resetKvCaches();
    await readCutPendingReady();
    expect(readCutPending(ME, wrong)).toBeUndefined();
  });
});
