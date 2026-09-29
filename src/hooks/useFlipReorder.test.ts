// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useFlipReorder } from "./useFlipReorder";

function rect(top: number, height = 10): DOMRect {
  return { top, left: 0, width: 10, height, bottom: top + height, right: 10, x: 0, y: top } as DOMRect;
}

/** An element whose rect is `tops[0]` before the reorder and `tops[1]` after. */
function keyed(key: string, tops: [number, number]) {
  const el = document.createElement("div");
  el.setAttribute("data-k", key);
  let phase = 0;
  el.getBoundingClientRect = () => rect(tops[phase]);
  const animate = vi.fn();
  el.animate = animate;
  return { el, animate, settle: () => void (phase = 1) };
}

describe("useFlipReorder", () => {
  it("animates each moved element from its old place, and a nested one only relative to its parent", () => {
    const container = document.createElement("div");
    const folder = keyed("folder", [0, 100]);
    const child = keyed("child", [10, 110]); // moves only because its folder moved
    const still = keyed("still", [50, 50]);
    folder.el.append(child.el);
    container.append(folder.el, still.el);

    const { result } = renderHook(() => useFlipReorder({ current: container }, "data-k"));
    result.current.capture();
    for (const x of [folder, child, still]) x.settle();
    result.current.play();

    expect(folder.animate).toHaveBeenCalledTimes(1);
    expect(folder.animate.mock.calls[0][0][0]).toEqual({ transform: "translate(0px, -100px)" });
    expect(child.animate).not.toHaveBeenCalled();
    expect(still.animate).not.toHaveBeenCalled();
  });

  it("starts an overridden element from the given rect (the drag ghost's)", () => {
    const container = document.createElement("div");
    const row = keyed("row", [0, 40]);
    container.append(row.el);

    const { result } = renderHook(() => useFlipReorder({ current: container }, "data-k"));
    result.current.capture({ row: rect(70) });
    row.settle();
    result.current.play();

    expect(row.animate.mock.calls[0][0][0]).toEqual({ transform: "translate(0px, 30px)" });
  });

  it("plays a capture once", () => {
    const container = document.createElement("div");
    const row = keyed("row", [0, 40]);
    container.append(row.el);

    const { result } = renderHook(() => useFlipReorder({ current: container }, "data-k"));
    result.current.capture();
    row.settle();
    result.current.play();
    result.current.play();

    expect(row.animate).toHaveBeenCalledTimes(1);
  });
});
