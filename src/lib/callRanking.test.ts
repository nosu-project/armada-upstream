import { describe, expect, it } from "vitest";

import { pickVisible, RECENT_SPEAKER_MS, type CallActivity } from "./callRanking";

const NOW = 1_000_000;
const idle: CallActivity = { streaming: false, handRaised: false };

function pick(people: string[], room: number, activity: Record<string, Partial<CallActivity>>) {
  return pickVisible(people, room, (p) => ({ ...idle, ...activity[p] }), NOW);
}

describe("pickVisible", () => {
  it("keeps everyone, in order, when they all fit", () => {
    expect(pick(["a", "b", "c"], 3, { c: { streaming: true } })).toEqual(["a", "b", "c"]);
  });

  it("falls back to join order with no activity", () => {
    expect(pick(["a", "b", "c", "d"], 2, {})).toEqual(["a", "b"]);
  });

  it("promotes streamers, then raised hands, then recent speakers", () => {
    const people = ["a", "b", "c", "d", "e"];
    const activity = {
      e: { streaming: true },
      d: { handRaised: true },
      c: { lastSpokeAt: NOW - 1_000 },
    };
    expect(pick(people, 1, activity)).toEqual(["e"]);
    expect(pick(people, 2, activity)).toEqual(["d", "e"]);
    // Display keeps join order, not rank order.
    expect(pick(people, 3, activity)).toEqual(["c", "d", "e"]);
  });

  it("prefers the most recent speaker", () => {
    expect(pick(["a", "b", "c"], 1, { b: { lastSpokeAt: NOW - 5_000 }, c: { lastSpokeAt: NOW - 100 } })).toEqual(["c"]);
  });

  it("forgets a speaker after the recent window", () => {
    expect(pick(["a", "b"], 1, { b: { lastSpokeAt: NOW - RECENT_SPEAKER_MS - 1 } })).toEqual(["a"]);
  });
});
