import { describe, expect, it } from "vitest";

import {
  countRows,
  resolveWindowEnd,
  resolveWindowStart,
  stepBackRows,
  stepForwardRows,
} from "@/components/chat/timelineWindow";

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

describe("window sizing when a flood is folded", () => {
  interface Row {
    id: string;
    spam: boolean;
  }
  /** `spam` quarantined messages between two runs of ordinary ones. */
  const mixed = (older: number, spam: number, newer: number): Row[] => [
    ...history(older).map((m) => ({ ...m, spam: false })),
    ...history(spam, older).map((m) => ({ ...m, spam: true })),
    ...history(newer, older + spam).map((m) => ({ ...m, spam: false })),
  ];
  const isSpam = (m: Row) => m.spam;

  it("counts a folded run as the one row it renders as", () => {
    // 200 spam messages under 5 real ones. Counted as messages, a 30-row
    // window sees nothing but spam and the conversation is above the slice;
    // counted as rows, the wall is one row and the window reaches the room.
    const entries = mixed(40, 200, 5);
    expect(resolveWindowStart(entries, null, 30).startIndex).toBe(215);
    const { startIndex } = resolveWindowStart(entries, null, 30, isSpam);
    expect(startIndex).toBeLessThan(40);
    expect(entries.slice(startIndex).filter((m) => !m.spam)).toHaveLength(29);
  });

  it("is unchanged when nothing is folded", () => {
    const entries = mixed(100, 0, 0);
    expect(resolveWindowStart(entries, null, 30, isSpam).startIndex).toBe(70);
  });

  it("steps back from the newest entry without reading past the end", () => {
    // `stepBackRows` looks at the entry BELOW each one to tell whether it is
    // already inside a folded row; starting at the end, there is none.
    const entries = mixed(5, 5, 0);
    expect(() => stepBackRows(entries, entries.length, 10, isSpam)).not.toThrow();
    expect(stepBackRows(entries, entries.length, 10, isSpam)).toBe(0);
  });

  it("steps back by rows, not messages, when revealing more", () => {
    const entries = mixed(40, 200, 5);
    // From the very bottom, one step of 10 rows crosses the whole wall.
    expect(stepBackRows(entries, entries.length, 10, isSpam)).toBeLessThan(40);
    // With no predicate it is the old fixed message step.
    expect(stepBackRows(entries, entries.length, 10)).toBe(entries.length - 10);
  });
});

describe("resolveWindowEnd", () => {
  it("reaches the newest entry when no anchor is set", () => {
    expect(resolveWindowEnd(history(100), null, 40)).toBe(100);
  });

  it("ends on the anchored message, so appends stay below the window", () => {
    const before = history(100);
    const after = [...before, { id: "m100" }];
    expect(resolveWindowEnd(before, "m60", 40)).toBe(61);
    expect(resolveWindowEnd(after, "m60", 40)).toBe(61);
  });

  it("stays bounded from the start when its anchor is lost", () => {
    expect(resolveWindowEnd(history(1000), "gone", 100, 240)).toBe(340);
  });
});

describe("window edges with a folded flood", () => {
  const rows = (pattern: string) => [...pattern].map((c, i) => ({ id: `m${i}`, spam: c === "s" }));
  const isSpam = (m: { spam: boolean }) => m.spam;

  it("counts a run as one row", () => {
    expect(countRows(rows("..sss.."), 0, 7, isSpam)).toBe(5);
    expect(countRows(rows("..sss.."), 3, 7, isSpam)).toBe(3);
    expect(countRows(rows("..sss.."), 0, 7)).toBe(7);
  });

  it("steps forward by rows without splitting a run", () => {
    const entries = rows("..sss..");
    expect(stepForwardRows(entries, 0, 3, isSpam)).toBe(5);
    expect(stepForwardRows(entries, 0, 2, isSpam)).toBe(2);
    expect(stepForwardRows(entries, 0, 99, isSpam)).toBe(7);
    expect(stepForwardRows(entries, 0, 3)).toBe(3);
  });
});
