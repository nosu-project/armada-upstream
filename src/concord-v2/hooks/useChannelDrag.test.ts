import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChannelDrag, type ChannelDropSlot } from "./useChannelDrag";

/** Two rows in the uncategorized run, then two under "Voice". */
const SLOTS: ChannelDropSlot[] = [
  { index: 0, category: undefined, y: 100 },
  { index: 1, category: undefined, y: 130 },
  { index: 1, category: "Voice", y: 200 },
  { index: 2, category: "Voice", y: 230 },
  { index: 3, category: undefined, y: 300, newCategory: true },
];

function pointer(type: string, init: Record<string, unknown> = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  return Object.assign(ev, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 0,
    clientY: 0,
    ...init,
  });
}

function press(y: number) {
  return { nativeEvent: pointer("pointerdown", { clientY: y }) } as unknown as React.PointerEvent;
}

function setup(enabled = true) {
  const onDrop = vi.fn();
  const columnRef = { current: document.createElement("div") as HTMLElement | null };
  const view = renderHook(() =>
    useChannelDrag({ enabled, columnRef, measure: () => SLOTS, onDrop }),
  );
  return { ...view, onDrop };
}

describe("useChannelDrag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aims at the nearest slot and drops the channel there", () => {
    const { result, onDrop } = setup();

    act(() => {
      result.current.onPointerDown("chan-a")(press(100));
      vi.advanceTimersByTime(300);
    });
    expect(result.current.sourceIdHex).toBe("chan-a");
    expect(result.current.indicatorY).toBe(100);

    act(() => void window.dispatchEvent(pointer("pointermove", { clientY: 228 })));
    expect(result.current.indicatorY).toBe(230);
    expect(result.current.target).toMatchObject({ index: 2, category: "Voice" });

    act(() => void window.dispatchEvent(pointer("pointerup", { clientY: 228 })));
    expect(onDrop).toHaveBeenCalledWith("chan-a", {
      index: 2,
      category: "Voice",
      newCategory: undefined,
    });
    expect(result.current.dragging).toBe(false);
    expect(result.current.indicatorY).toBeNull();
  });

  it("reports the trailing zone so the caller can prompt for a name", () => {
    const { result, onDrop } = setup();
    act(() => {
      result.current.onPointerDown("chan-a")(press(100));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointer("pointermove", { clientY: 295 }));
    });
    expect(result.current.target).toMatchObject({ newCategory: true });
    act(() => void window.dispatchEvent(pointer("pointerup", { clientY: 295 })));
    expect(onDrop).toHaveBeenCalledWith("chan-a", {
      index: 3,
      category: undefined,
      newCategory: true,
    });
  });

  it("drops nothing when the browser reclaims the pointer", () => {
    const { result, onDrop } = setup();
    act(() => {
      result.current.onPointerDown("chan-a")(press(100));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointer("pointercancel"));
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(result.current.dragging).toBe(false);
  });

  it("does nothing at all for a member who can't rearrange", () => {
    const { result, onDrop } = setup(false);
    act(() => {
      result.current.onPointerDown("chan-a")(press(100));
      vi.advanceTimersByTime(300);
      window.dispatchEvent(pointer("pointerup", { clientY: 100 }));
    });
    expect(result.current.dragging).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
