import { describe, expect, it, vi } from "vitest";

import { LatestSerialRunner } from "@/lib/pushRegistration";

describe("LatestSerialRunner", () => {
  it("serializes workers and tells a running generation when it is stale", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    const current: Array<[number, boolean]> = [];
    const runner = new LatestSerialRunner<number, number>(async (value, isCurrent) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (value === 1) await gate;
      current.push([value, isCurrent()]);
      active -= 1;
      return value;
    });

    const first = runner.run(1);
    await Promise.resolve();
    const second = runner.run(2);
    release();

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(maxActive).toBe(1);
    expect(current).toEqual([[1, false], [2, true]]);
  });

  it("coalesces a queued generation that was superseded before it started", async () => {
    const worker = vi.fn(async (value: number) => value);
    const runner = new LatestSerialRunner(worker);

    const first = runner.run(1);
    const second = runner.run(2);

    expect(await first).toBeUndefined();
    expect(await second).toBe(2);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(2, expect.any(Function));
  });
});
