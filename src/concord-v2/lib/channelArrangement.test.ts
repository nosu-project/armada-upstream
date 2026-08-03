import { describe, expect, it } from "vitest";

import {
  arrangementChanges,
  planChannelDrop,
  type ArrangedChannel,
} from "@/concord-v2/lib/channelArrangement";

/** A rendered sidebar: three loose channels, then a "Voice" category. */
const rendered: ArrangedChannel[] = [
  { idHex: "a", position: 0 },
  { idHex: "b", position: 1 },
  { idHex: "c", position: 2 },
  { idHex: "d", position: 3, category: "Voice" },
  { idHex: "e", position: 4, category: "Voice" },
];

const ids = (list: readonly ArrangedChannel[]) => list.map((c) => c.idHex);

describe("planChannelDrop", () => {
  it("moves a channel down, indexing the list without it", () => {
    expect(ids(planChannelDrop(rendered, "a", 2, undefined))).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("moves a channel up", () => {
    expect(ids(planChannelDrop(rendered, "c", 0, undefined))).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("carries the channel into the category it was dropped in", () => {
    const next = planChannelDrop(rendered, "a", 3, "Voice");
    expect(ids(next)).toEqual(["b", "c", "d", "a", "e"]);
    expect(next.find((c) => c.idHex === "a")?.category).toBe("Voice");
  });

  it("drops a channel out of its category", () => {
    const next = planChannelDrop(rendered, "d", 0, undefined);
    expect(next[0]).toMatchObject({ idHex: "d", category: undefined });
  });

  it("clamps an index past either end", () => {
    expect(ids(planChannelDrop(rendered, "a", 99, undefined))).toEqual(["b", "c", "d", "e", "a"]);
    expect(ids(planChannelDrop(rendered, "e", -5, undefined))).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("leaves an unknown channel alone", () => {
    expect(ids(planChannelDrop(rendered, "zz", 0, undefined))).toEqual(ids(rendered));
  });
});

describe("arrangementChanges", () => {
  it("republishes only the run a move disturbed", () => {
    // c jumps to the top: a and b shift down one, d and e never move.
    const next = planChannelDrop(rendered, "c", 0, undefined);
    expect(arrangementChanges(rendered, next)).toEqual([
      { idHex: "c", position: 0, category: undefined },
      { idHex: "a", position: 1, category: undefined },
      { idHex: "b", position: 2, category: undefined },
    ]);
  });

  it("emits the filing even when the slot is unchanged", () => {
    // The regression this exists for: dropping a channel into the category
    // that already sits at its index changes the category and nothing else.
    const before: ArrangedChannel[] = [{ idHex: "a", position: 0 }, { idHex: "b", position: 1, category: "Voice" }];
    const next = planChannelDrop(before, "a", 0, "Voice");
    expect(arrangementChanges(before, next)).toEqual([{ idHex: "a", position: 0, category: "Voice" }]);
  });

  it("stamps every channel the first time a never-arranged community is dragged", () => {
    const unarranged: ArrangedChannel[] = [{ idHex: "a" }, { idHex: "b" }, { idHex: "c" }];
    expect(arrangementChanges(unarranged, planChannelDrop(unarranged, "c", 0, undefined))).toHaveLength(3);
  });

  it("is a no-op when nothing moved", () => {
    expect(arrangementChanges(rendered, planChannelDrop(rendered, "b", 1, undefined))).toEqual([]);
  });

  it("treats a case-only category respelling as no change", () => {
    const next = planChannelDrop(rendered, "d", 3, "voice");
    expect(arrangementChanges(rendered, next)).toEqual([]);
  });

  it("normalizes a blank category to uncategorized", () => {
    const before: ArrangedChannel[] = [{ idHex: "a", position: 0, category: "Voice" }];
    expect(arrangementChanges(before, planChannelDrop(before, "a", 0, "   "))).toEqual([
      { idHex: "a", position: 0, category: undefined },
    ]);
  });
});
