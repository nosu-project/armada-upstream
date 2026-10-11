import { describe, expect, it } from "vitest";

import { roundWatch, settleDue, SPEC_SETTLE_MAX_MS, SPEC_SETTLE_MS } from "@/wire/roundWatch";

const T = 10_000_000;

describe("roundWatch()", () => {
  it("re-issues a round that never answered", () => {
    expect(roundWatch(T, T - 31_000, T - 31_000, false, false)).toBe("reissue");
    expect(roundWatch(T, T - 10_000, T - 10_000, false, false)).toBe("none");
  });

  it("probes a quiet established round instead of re-sending its filters", () => {
    expect(roundWatch(T, T - 120_000, T - 91_000, true, false)).toBe("probe");
    expect(roundWatch(T, T - 120_000, T - 91_000, true, true), "one probe at a time").toBe("none");
    expect(roundWatch(T, T - 120_000, T - 30_000, true, false)).toBe("none");
  });

  it("rotates a quiet round only after the long backstop", () => {
    expect(roundWatch(T, T - 15 * 60_000, T - 91_000, true, false)).toBe("rotate");
    expect(roundWatch(T, T - 15 * 60_000, T - 30_000, true, false), "never while traffic flows").toBe("none");
  });
});

describe("settleDue()", () => {
  it("defers a running loop's restart until the spec has been quiet", () => {
    expect(settleDue(T, undefined, T)).toBe(T + SPEC_SETTLE_MS);
    // Another change inside the window pushes it out again.
    expect(settleDue(T, T + SPEC_SETTLE_MS, T + 1_000)).toBe(T + 1_000 + SPEC_SETTLE_MS);
    // The timer firing at the due time restarts.
    expect(settleDue(T, T + SPEC_SETTLE_MS, T + SPEC_SETTLE_MS)).toBe(true);
  });

  it("never waits past the cap from the first change", () => {
    expect(settleDue(T, T + 4_800, T + 4_000)).toBe(T + SPEC_SETTLE_MAX_MS);
    expect(settleDue(T, T + 6_000, T + SPEC_SETTLE_MAX_MS)).toBe(true);
  });
});
