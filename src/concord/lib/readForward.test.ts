import { describe, expect, it } from "vitest";

import { readForward, type WindowRead } from "@/concord/lib/readForward";

/** A source holding one row per listed second, which truncates past `cap` rows. */
function source(seconds: number[], cap: number) {
  const reads: Array<[number, number]> = [];
  const read = async (since: number, until: number): Promise<WindowRead<number>> => {
    reads.push([since, until]);
    const rows = seconds.filter((s) => s >= since && s <= until);
    return rows.length > cap ? { rows: rows.slice(-cap), complete: false } : { rows, complete: true };
  };
  return { read, reads };
}

const base = { count: (rows: readonly number[]) => rows.length, maxReads: 20 };

describe("readForward", () => {
  it("halves an over-full window and only covers what came back whole", async () => {
    const s = source([101, 102, 103, 104, 105, 106, 107, 108], 4);
    const r = await readForward({ ...base, read: s.read, from: 100, ceiling: 1000, want: 3, span: 100 });
    expect(r.failed).toBe(false);
    // [100,200] holds 8 > 4, so it is halved until a window fits, oldest rows first.
    expect(s.reads[0]).toEqual([100, 200]);
    expect(r.coveredTo).toBeDefined();
    const covered = r.coveredTo!;
    for (const sec of [101, 102, 103, 104, 105, 106, 107, 108].filter((x) => x <= covered)) {
      expect(r.rows).toContain(sec);
    }
    expect(covered).toBeLessThan(200);
  });

  it("grows the window across a quiet stretch and stops at the ceiling", async () => {
    const s = source([5000], 10);
    const r = await readForward({ ...base, read: s.read, from: 0, ceiling: 6000, want: 50, span: 10 });
    expect(r.coveredTo).toBe(6000);
    expect(r.rows).toEqual([5000]);
    // Doubling reaches the ceiling in far fewer reads than fixed 10-second windows.
    expect(s.reads.length).toBeLessThan(12);
  });

  it("stops at a failed read without claiming its window", async () => {
    let n = 0;
    const r = await readForward({
      ...base,
      from: 0,
      ceiling: 100,
      want: 10,
      span: 10,
      read: async (since, until) => (n++ === 0 ? { rows: [since], complete: true } : { rows: [until], complete: false, failed: true }),
    });
    expect(r).toEqual({ rows: [0, 31], coveredTo: 10, failed: true });
  });
});
