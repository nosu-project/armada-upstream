/**
 * The persisted flood verdict — merge semantics, retention, and the cap.
 *
 * What matters here is the one-way door: writers only ever ADD ids, so a fold
 * with less context (a fresh session's shallow window) can never un-remember
 * what a better-informed fold decided. Un-remembering is retention's job.
 */
import { describe, expect, it } from "vitest";

import {
  QUARANTINE_MAX_IDS,
  QUARANTINE_RETENTION_MS,
  quarantineMemoryReady,
  recallQuarantined,
  rememberQuarantined,
} from "@/concord/lib/quarantineMemory";

/** A distinct community per test keeps the shared KV out of the assertions. */
const community = (n: number) => n.toString(16).padStart(64, "0");

describe("quarantine memory", () => {
  it("answers undefined for a channel that never folded anything", async () => {
    await quarantineMemoryReady();
    expect(recallQuarantined(community(1), "chan")).toBeUndefined();
  });

  it("merges new verdicts into what is already remembered", async () => {
    const c = community(2);
    await rememberQuarantined(c, "chan", [["r1", Date.now()]]);
    await rememberQuarantined(c, "chan", [["r2", Date.now()]]);
    expect(recallQuarantined(c, "chan")).toEqual(new Set(["r1", "r2"]));
    // Channels don't share memory.
    expect(recallQuarantined(c, "other")).toBeUndefined();
  });

  it("prunes verdicts whose messages have aged past retention", async () => {
    const c = community(3);
    const stale = Date.now() - QUARANTINE_RETENTION_MS - 60_000;
    await rememberQuarantined(c, "chan", [["old", stale]]);
    // Nothing within retention survived, so nothing is remembered at all.
    expect(recallQuarantined(c, "chan")).toBeUndefined();
    await rememberQuarantined(c, "chan", [["new", Date.now()]]);
    expect(recallQuarantined(c, "chan")).toEqual(new Set(["new"]));
  });

  it("caps one channel's memory at the newest QUARANTINE_MAX_IDS", async () => {
    const c = community(4);
    const now = Date.now();
    const entries = Array.from(
      { length: QUARANTINE_MAX_IDS + 5 },
      (_, i) => [`r${i}`, now - i * 1000] as const,
    );
    await rememberQuarantined(c, "chan", entries);
    const ids = recallQuarantined(c, "chan");
    expect(ids?.size).toBe(QUARANTINE_MAX_IDS);
    expect(ids?.has("r0")).toBe(true);
    expect(ids?.has(`r${QUARANTINE_MAX_IDS + 4}`)).toBe(false);
  });

  it("re-adding a known id is a no-op, not a rewrite", async () => {
    const c = community(5);
    await rememberQuarantined(c, "chan", [["r1", Date.now()]]);
    const before = recallQuarantined(c, "chan");
    await rememberQuarantined(c, "chan", [["r1", Date.now() + 5000]]);
    // Same stored value, so the memoized set view is the same object.
    expect(recallQuarantined(c, "chan")).toBe(before);
  });
});
