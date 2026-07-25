import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LONG_PRESS_MS, useLongPress } from "@/hooks/useLongPress";

/** Minimal pointer-event factory — only the fields the hook reads. */
function pointer(
  x: number,
  y: number,
  { pointerType = "touch", target }: { pointerType?: string; target?: unknown } = {},
) {
  return {
    pointerType,
    clientX: x,
    clientY: y,
    target: target ?? { closest: () => null },
  } as unknown as React.PointerEvent;
}

/** A press target that reports itself as inside an interactive element. */
const interactiveTarget = { closest: (sel: string) => (sel.includes("button") ? {} : null) };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useLongPress", () => {
  it("fires after the hold duration", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the finger lifts first", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS - 50));
    act(() => result.current.onPointerUp?.());
    act(() => void vi.advanceTimersByTime(200));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels when the press turns into a scroll", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    act(() => result.current.onPointerMove?.(pointer(100, 140)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("tolerates the small drift of a finger held still", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    act(() => result.current.onPointerMove?.(pointer(103, 102)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("ignores a mouse press — the pointer surfaces have hover and right-click", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { pointerType: "mouse" })));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("ignores a press that starts on an interactive child", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { target: interactiveTarget })));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("swallows the click that follows a fired press", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;

    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
    act(() => result.current.onClick?.(click));

    expect(click.preventDefault).toHaveBeenCalled();
    // …and only that one click: the next tap must act normally.
    const next = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;
    act(() => result.current.onClick?.(next));
    expect(next.preventDefault).not.toHaveBeenCalled();
  });

  it("does nothing at all without a callback", () => {
    const { result } = renderHook(() => useLongPress(undefined));
    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
    // No throw is the assertion.
    expect(result.current.onPointerDown).toBeTypeOf("function");
  });
});
