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

/** Subpaths in a `d`, i.e. dots in a frame's dot strip. */
const subpaths = (d: string) => (d.match(/M/g) ?? []).length;

describe("timer frames", () => {
  it("generates the full 13-frame strip", () => {
    expect(TIMER_FRAMES).toHaveLength(13);
    expect(LAST_FRAME).toBe(12);
    for (const { hand } of TIMER_FRAMES) expect(hand.startsWith("M")).toBe(true);
  });

  it("trades one dot for one twelfth of ring per frame", () => {
    // The two halves of the face are complementary: what the ring has given up
    // is exactly what the dots show, so no frame can be drawn short or double.
    for (const [frame, { ring, dots }] of TIMER_FRAMES.entries()) {
      expect(subpaths(dots)).toBe(12 - frame);
      expect(ring === "").toBe(frame === 0);
    }
  });

  it("closes the ring only when the message is untouched", () => {
    // A full turn is two half-turn arcs; every partial frame is one arc.
    expect(subpaths(TIMER_FRAMES[12].ring)).toBe(1);
    expect(TIMER_FRAMES[12].ring.match(/A/g)).toHaveLength(2);
    expect(TIMER_FRAMES[11].ring.match(/A/g)).toHaveLength(1);
    expect(TIMER_FRAMES[12].dots).toBe("");
  });

  it("points the hand at the depletion boundary", () => {
    // The hand, the live arc's moving end and the newest gap must share one
    // angle, or the hand drifts away from where the ring is being spent.
    for (let frame = 1; frame < 12; frame++) {
      const { ring, hand } = TIMER_FRAMES[frame];
      const [rx, ry] = ring.match(/M ([\d.-]+) ([\d.-]+)/)!.slice(1).map(Number);
      const [hx, hy] = hand.match(/L ([\d.-]+) ([\d.-]+)/)!.slice(1).map(Number);
      const ringAngle = Math.atan2(rx - 6, 6 - ry);
      const handAngle = Math.atan2(hx - 6, 6 - hy);
      // The emitted coordinates are rounded to 3 decimals, so the angles can
      // disagree by up to ~1e-4 radians without the geometry being wrong.
      expect(handAngle).toBeCloseTo(ringAngle, 3);
    }
  });

  it("sweeps the hand a full turn, ending where it started", () => {
    // Up at 12, down at 6, back up at 0, so the two ends coincide and the
    // half-way frame is its opposite.
    expect(TIMER_FRAMES[0].hand).toBe(TIMER_FRAMES[12].hand);
    expect(TIMER_FRAMES[12].hand).toBe("M 6 6 L 6 2.5");
    expect(TIMER_FRAMES[6].hand).toBe("M 6 6 L 6 9.5");
    // COUNTERCLOCKWISE: a quarter spent points the hand at 9 o'clock, not 3.
    expect(TIMER_FRAMES[9].hand).toBe("M 6 6 L 2.5 6");
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
