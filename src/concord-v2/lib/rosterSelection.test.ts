import { describe, expect, it } from "vitest";

import { clickRow, emptySelection, pruneSelection } from "@/concord-v2/lib/rosterSelection";

const order = ["a", "b", "c", "d", "e"];

describe("rosterSelection", () => {
  it("plain click toggles and re-anchors", () => {
    let s = clickRow(emptySelection(), order, "b", false);
    expect([...s.selected]).toEqual(["b"]);
    expect(s.anchor).toBe("b");
    s = clickRow(s, order, "b", false);
    expect(s.selected.size).toBe(0);
    expect(s.anchor).toBe("b");
  });

  it("shift-click applies the anchor's state across the range, both directions", () => {
    // Anchor selected → range selects.
    let s = clickRow(emptySelection(), order, "b", false);
    s = clickRow(s, order, "d", true);
    expect([...s.selected].sort()).toEqual(["b", "c", "d"]);
    expect(s.anchor, "anchor survives for re-ranging").toBe("b");

    // Upward range from the same anchor.
    s = clickRow(s, order, "a", true);
    expect([...s.selected].sort()).toEqual(["a", "b", "c", "d"]);

    // Anchor DEselected → range deselects.
    let d = clickRow(emptySelection(), order, "a", false);
    d = clickRow(d, order, "e", true); // a..e all selected
    d = clickRow(d, order, "c", false); // toggle c OFF, anchor=c
    d = clickRow(d, order, "e", true); // c..e take c's state: off
    expect([...d.selected].sort()).toEqual(["a", "b"]);
  });

  it("shift-click with no usable anchor degrades to a plain click", () => {
    const s = clickRow(emptySelection(), order, "c", true);
    expect([...s.selected]).toEqual(["c"]);
    expect(s.anchor).toBe("c");

    // Anchor no longer in the visible order (filtered out) → plain click.
    let t = clickRow(emptySelection(), order, "a", false);
    t = { ...t, anchor: "zz" };
    t = clickRow(t, order, "d", true);
    expect([...t.selected].sort()).toEqual(["a", "d"]);
    expect(t.anchor).toBe("d");
  });

  it("re-sort re-ranges from the same member, not the same index", () => {
    let s = clickRow(emptySelection(), order, "d", false); // anchor=d
    const resorted = ["d", "e", "a", "b", "c"];
    s = clickRow(s, resorted, "a", true); // d..a in the NEW order = d,e,a
    expect([...s.selected].sort()).toEqual(["a", "d", "e"]);
  });

  it("clicking a row not in the order is a no-op", () => {
    const s = clickRow(emptySelection(), order, "zz", false);
    expect(s.selected.size).toBe(0);
    expect(s.anchor).toBeUndefined();
  });

  it("pruneSelection drops vanished rows and a vanished anchor", () => {
    let s = clickRow(emptySelection(), order, "a", false);
    s = clickRow(s, order, "e", true); // all five
    const pruned = pruneSelection(s, new Set(["a", "c", "e"]));
    expect([...pruned.selected].sort()).toEqual(["a", "c", "e"]);
    expect(pruned.anchor).toBe("a");

    const anchorGone = pruneSelection(s, new Set(["b", "c"]));
    expect([...anchorGone.selected].sort()).toEqual(["b", "c"]);
    expect(anchorGone.anchor).toBeUndefined();

    // Nothing to drop → same reference (memo-friendly).
    expect(pruneSelection(pruned, new Set(["a", "c", "e"]))).toBe(pruned);
  });
});
