import { describe, expect, it } from "vitest";

import { resolveWindowStart } from "@/components/chat/timelineWindow";

/** `n` messages with ids "m{offset}".."m{offset+n-1}", oldest first. */
function history(n: number, offset = 0): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i + offset}` }));
}

describe("resolveWindowStart", () => {
  it("renders only the newest slice when no anchor is set", () => {
    expect(resolveWindowStart(history(100), null, 30)).toEqual({
      startIndex: 70,
      anchorLost: false,
    });
  });

  it("renders everything when the history is shorter than the window", () => {
    expect(resolveWindowStart(history(12), null, 30)).toEqual({
      startIndex: 0,
      anchorLost: false,
    });
  });

  it("handles an empty history", () => {
    expect(resolveWindowStart([], null, 30)).toEqual({ startIndex: 0, anchorLost: false });
    expect(resolveWindowStart([], "m0", 30)).toEqual({ startIndex: 0, anchorLost: false });
  });

  it("starts at the anchored message", () => {
    expect(resolveWindowStart(history(100), "m40", 30)).toEqual({
      startIndex: 40,
      anchorLost: false,
    });
  });

  it("grows at the bottom when newer messages arrive", () => {
    const before = history(100);
    const after = [...before, { id: "m100" }, { id: "m101" }];
    expect(resolveWindowStart(before, "m40", 30).startIndex).toBe(40);
    expect(resolveWindowStart(after, "m40", 30).startIndex).toBe(40);
  });

  it("keeps its top on the same message when older ones are prepended", () => {
    const prepended = [...history(50, -50), ...history(100)];
    const { startIndex, anchorLost } = resolveWindowStart(prepended, "m0", 30);
    expect(anchorLost).toBe(false);
    // Same message, now 50 rows further in — the backfilled page sits above it,
    // loaded but not yet revealed.
    expect(prepended[startIndex].id).toBe("m0");
    expect(startIndex).toBe(50);
  });

  it("reports a lost anchor when the conversation changes underneath it", () => {
    expect(resolveWindowStart(history(80, 1000), "m40", 30)).toEqual({
      startIndex: 50,
      anchorLost: true,
    });
  });
});
