import { describe, expect, it } from "vitest";

import { KeyedThrottle } from "./keyedThrottle";

/** Drive the throttle like a timer loop, returning when each value fired. */
function simulate(arrivals: Array<[number, string]>, debounceMs: number, minGapMs: number, until: number) {
  const throttle = new KeyedThrottle<string>(debounceMs, minGapMs);
  const fired: Array<[number, string]> = [];
  let timerAt: number | undefined;
  let i = 0;
  for (let now = 0; now <= until; now++) {
    while (i < arrivals.length && arrivals[i][0] === now) {
      throttle.add(arrivals[i][1], arrivals[i][1]);
      i++;
      // A new key may be due sooner than the armed timer: re-arm earlier.
      const delay = throttle.nextDelay(now);
      if (delay !== undefined && (timerAt === undefined || now + delay < timerAt)) timerAt = now + delay;
    }
    if (timerAt === now) {
      timerAt = undefined;
      for (const value of throttle.takeDue(now)) fired.push([now, value]);
      const delay = throttle.nextDelay(now);
      if (delay !== undefined) timerAt = now + delay;
    }
  }
  return fired;
}

describe("KeyedThrottle", () => {
  it("fires a lone request after the debounce", () => {
    expect(simulate([[0, "list"]], 60, 15_000, 1_000)).toEqual([[60, "list"]]);
  });

  it("holds a key that keeps arriving to one fire per gap", () => {
    // An edition every second for a minute: the recorded flood's pace.
    const arrivals: Array<[number, string]> = [];
    for (let t = 0; t < 60_000; t += 1_000) arrivals.push([t, "list"]);
    const fired = simulate(arrivals, 60, 15_000, 80_000);
    expect(fired.map(([t]) => t)).toEqual([60, 15_060, 30_060, 45_060, 60_060]);
  });

  it("does not delay other keys behind a throttled one", () => {
    const fired = simulate([[0, "list"], [1_000, "list"], [1_000, "mutes"]], 60, 15_000, 20_000);
    expect(fired).toEqual([[60, "list"], [1_060, "mutes"], [15_060, "list"]]);
  });
});
