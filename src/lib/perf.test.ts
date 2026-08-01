/**
 * The profiler's own contract, because a broken instrument is worse than none:
 * it sends the next fix at the wrong thing.
 *
 * Two properties matter. Aggregates must separate "one call did all the work"
 * from "a thousand calls each did a little" — that distinction is the entire
 * reason the module counts calls and units rather than just summing time. And a
 * failing operation must still be charged for the time it burned, or a read that
 * throws after two seconds reads as free.
 */

import { afterEach, describe, expect, it } from "vitest";

import { __resetPerfForTests, perfCount, perfMark, perfReport, perfReset, perfTime } from "./perf";

afterEach(() => {
  __resetPerfForTests();
});

describe("perfReport", () => {
  it("separates one expensive call from many cheap ones", () => {
    perfCount("one big read", 500, 40_000, "rows");
    for (let i = 0; i < 400; i++) perfCount("many small reads", 2, 100, "rows");

    const { aggregates } = perfReport();

    // Sorted by total cost, so the thing to fix is first.
    expect(aggregates[0].label).toBe("many small reads");
    expect(aggregates[0].count).toBe(400);
    expect(aggregates[0].total).toBeCloseTo(800, 5);
    expect(aggregates[0].mean).toBeCloseTo(2, 5);
    expect(aggregates[0].units).toBe(40_000);

    // Identical row counts, comparable totals — only `count`/`mean`/`max` tell
    // the two shapes apart, which is why all three are reported.
    expect(aggregates[1].label).toBe("one big read");
    expect(aggregates[1].count).toBe(1);
    expect(aggregates[1].total).toBeCloseTo(500, 5);
    expect(aggregates[1].max).toBeCloseTo(500, 5);
    expect(aggregates[1].units).toBe(40_000);
  });

  it("charges a rejected operation for the time it spent", async () => {
    await expect(
      perfTime("failing read", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("transaction aborted");
      }),
    ).rejects.toThrow("transaction aborted");

    const bucket = perfReport().aggregates.find((a) => a.label === "failing read");
    expect(bucket?.count).toBe(1);
    expect(bucket?.total).toBeGreaterThan(0);
  });

  it("counts the work a successful operation returned", async () => {
    await perfTime("counted read", async () => [1, 2, 3], (rows) => rows.length, "rows");

    const bucket = perfReport().aggregates.find((a) => a.label === "counted read");
    expect(bucket?.units).toBe(3);
    expect(bucket?.unitName).toBe("rows");
  });

  it("keeps repeated milestones, in order — a milestone reached twice is a finding", () => {
    perfMark("mounted");
    perfMark("mounted", "again");

    const { timeline } = perfReport();
    expect(timeline.map((m) => m.label)).toEqual(["mounted", "mounted"]);
    expect(timeline[1].detail).toBe("again");
    expect(timeline[1].at).toBeGreaterThanOrEqual(timeline[0].at);
  });

  it("perfReset drops aggregates but keeps the boot timeline", () => {
    perfMark("mounted");
    perfCount("read", 10);

    perfReset();

    const report = perfReport();
    expect(report.aggregates).toEqual([]);
    // The boot is not repeatable, so resetting the counters must not erase it.
    expect(report.timeline.map((m) => m.label)).toEqual(["mounted"]);
  });
});
