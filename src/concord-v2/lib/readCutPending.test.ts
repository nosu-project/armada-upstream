import { beforeEach, describe, expect, it } from "vitest";

import {
  addReadCutPending,
  clearReadCutPending,
  readCutPending,
  readCutPendingReady,
} from "@/concord-v2/lib/readCutPending";
import { resetKvCaches } from "@/lib/db/kvCache";

const ME = "me".padEnd(64, "0");
const CID = "cid".padEnd(64, "0");
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);

describe("readCutPending", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips targets + keep, and empties to undefined", () => {
    expect(readCutPending(ME, CID)).toBeUndefined();
    addReadCutPending(ME, CID, A, [B, C]);
    expect(readCutPending(ME, CID)).toEqual({ targets: [A], keep: [B, C] });
    clearReadCutPending(ME, CID);
    expect(readCutPending(ME, CID)).toBeUndefined();
  });

  it("never keeps a target in the keep-list (the persisted keep drives the retry's recipients)", () => {
    // Ban A keeping {B, C}; then ban B keeping {C} — B must leave the keep set.
    addReadCutPending(ME, CID, A, [B, C]);
    addReadCutPending(ME, CID, B, [C]);
    const pending = readCutPending(ME, CID)!;
    expect(new Set(pending.targets)).toEqual(new Set([A, B]));
    expect(pending.keep).not.toContain(A);
    expect(pending.keep).not.toContain(B);
    expect(pending.keep).toContain(C);
  });

  it("is scoped per (account, community)", () => {
    addReadCutPending(ME, CID, A, [B]);
    expect(readCutPending("other".padEnd(64, "0"), CID)).toBeUndefined();
    expect(readCutPending(ME, "other".padEnd(64, "0"))).toBeUndefined();
  });

  it("reads an intent the startup migration moved out of localStorage", async () => {
    // The intent moved into ArmadaDB's KV. A ban that failed its rotation
    // before the upgrade still has to be retried after it. Nothing here reads
    // localStorage — the gate's migration is what puts the value in KV.
    // A community of its own: the migration will not overwrite a KV value the
    // session already wrote, and the tests above have written to `CID`.
    const cid = "moved".padEnd(64, "0");
    resetKvCaches();
    localStorage.setItem(
      `concord2:read-cut-pending:${ME}:${cid}`,
      JSON.stringify({ targets: [A], keep: [B, C] }),
    );

    const { SCHEMA_MIGRATIONS } = await import("@/lib/db/schema");
    await SCHEMA_MIGRATIONS[0].run(undefined);
    await readCutPendingReady();

    expect(readCutPending(ME, cid)).toEqual({ targets: [A], keep: [B, C] });
    expect(localStorage.getItem(`concord2:read-cut-pending:${ME}:${cid}`)).toBeNull();
  });

  it("ignores a malformed stored value", async () => {
    // The migration keeps an unparseable value as the string it is rather than
    // dropping it, so the shape check here is what refuses it.
    const bad = "bad".padEnd(64, "0");
    resetKvCaches();
    localStorage.setItem(`concord2:read-cut-pending:${ME}:${bad}`, "{ not json");
    const { SCHEMA_MIGRATIONS } = await import("@/lib/db/schema");
    await SCHEMA_MIGRATIONS[0].run(undefined);
    await readCutPendingReady();
    expect(readCutPending(ME, bad)).toBeUndefined();

    const wrong = "wrong".padEnd(64, "0");
    const { getArmadaDB } = await import("@/lib/db/armadaDB");
    await getArmadaDB().kv.set(`read-cut-pending:${ME}:${wrong}`, { targets: "x", keep: [] });
    resetKvCaches();
    await readCutPendingReady();
    expect(readCutPending(ME, wrong)).toBeUndefined();
  });
});
