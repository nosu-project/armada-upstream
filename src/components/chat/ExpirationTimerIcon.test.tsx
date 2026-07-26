import { describe, expect, it } from "vitest";

import {
  frameAt,
  LAST_FRAME,
  nextFrameChangeMs,
  TIMER_FRAMES,
} from "@/components/chat/ExpirationTimerIcon";

const CREATED = 1_700_000_000;
/** A one-hour timer, so each of the 12 steps is a tidy five minutes. */
const HOUR = 3600;
const EXPIRES = CREATED + HOUR;
const at = (secs: number) => (CREATED + secs) * 1000;

describe("timer frames", () => {
  it("carries Signal's full 13-frame strip", () => {
    expect(TIMER_FRAMES).toHaveLength(13);
    expect(LAST_FRAME).toBe(12);
    for (const d of TIMER_FRAMES) expect(d.startsWith("M")).toBe(true);
  });
});

describe("frameAt", () => {
  it("starts full and ends empty", () => {
    expect(frameAt(CREATED, EXPIRES, at(0))).toBe(12);
    expect(frameAt(CREATED, EXPIRES, at(HOUR))).toBe(0);
  });

  it("steps down once per twelfth of the lifetime", () => {
    // Frame 12 covers the FIRST twelfth (remaining in (11/12, 12/12]), so each
    // boundary is where the face has just lost another twelfth.
    for (let step = 0; step <= 12; step++) {
      expect(frameAt(CREATED, EXPIRES, at(step * (HOUR / 12)))).toBe(12 - step);
    }
  });

  it("holds a frame through its whole twelfth", () => {
    // Sampled just past each boundary: still the same frame the boundary set.
    for (let step = 0; step < 12; step++) {
      expect(frameAt(CREATED, EXPIRES, at(step * (HOUR / 12) + 1))).toBe(12 - step);
    }
  });

  it("holds at the ends rather than running past them", () => {
    // A clock rendered before its message's timestamp, or long after the
    // deadline, must still land on a real frame.
    expect(frameAt(CREATED, EXPIRES, at(-500))).toBe(12);
    expect(frameAt(CREATED, EXPIRES, at(HOUR * 10))).toBe(0);
  });

  it("shows the empty face when there is no runway to animate over", () => {
    expect(frameAt(CREATED, CREATED, at(0))).toBe(0);
    expect(frameAt(CREATED, CREATED - 10, at(0))).toBe(0);
  });
});

describe("nextFrameChangeMs", () => {
  it("schedules each redraw on the twelfth boundary", () => {
    // Full → 11 once the first twelfth is spent.
    expect(nextFrameChangeMs(CREATED, EXPIRES, 12)).toBe(at(HOUR / 12));
    // 6 → 5 once seven twelfths are spent.
    expect(nextFrameChangeMs(CREATED, EXPIRES, 6)).toBe(at((HOUR * 7) / 12));
    // 1 → 0 exactly at the deadline.
    expect(nextFrameChangeMs(CREATED, EXPIRES, 1)).toBe(at(HOUR));
  });

  it("stops scheduling once the face is empty", () => {
    expect(nextFrameChangeMs(CREATED, EXPIRES, 0)).toBeUndefined();
    expect(nextFrameChangeMs(CREATED, CREATED, 5)).toBeUndefined();
  });

  it("lands on a boundary that re-derives the next frame down", () => {
    // The scheduling contract: waking at the returned instant (plus the
    // component's small nudge past it) must actually advance the frame, or the
    // effect would re-arm on the same boundary forever.
    for (let frame = 12; frame > 0; frame--) {
      const boundary = nextFrameChangeMs(CREATED, EXPIRES, frame)!;
      expect(frameAt(CREATED, EXPIRES, boundary + 50)).toBeLessThan(frame);
    }
  });
});
