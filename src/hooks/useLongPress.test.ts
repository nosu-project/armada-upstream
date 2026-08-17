import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LONG_PRESS_MS, useLongPress } from "@/hooks/useLongPress";

/** Minimal pointer-event factory — only the fields the hook reads. */
function pointer(
  x: number,
  y: number,
  { pointerType = "touch", target, timeStamp = 0, pointerId }: { pointerType?: string; target?: unknown; timeStamp?: number; pointerId?: number } = {},
) {
  return {
    pointerType,
    clientX: x,
    clientY: y,
    timeStamp,
    pointerId,
    target: target ?? { closest: () => null },
  } as unknown as React.PointerEvent;
}

/** A press target that reports itself as inside an interactive element. */
const interactiveTarget = { closest: (sel: string) => (sel.includes("button") ? {} : null) };

/**
 * Dispatch a real pointer event on the window — the path the hook watches once
 * a hold is armed, and the only one left when an ancestor takes pointer
 * capture. jsdom has no PointerEvent, so the fields the hook reads are pinned
 * onto a plain Event.
 */
function dispatchWindowPointer(
  type: "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
  { pointerId = 1, timeStamp }: { pointerId?: number; timeStamp?: number } = {},
) {
  const e = new Event(type);
  Object.assign(e, { clientX: x, clientY: y, pointerId });
  if (timeStamp !== undefined) Object.defineProperty(e, "timeStamp", { value: timeStamp });
  window.dispatchEvent(e);
}

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
    act(() => result.current.onPointerUp?.(pointer(100, 100)));
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

  it("fires on an interactive target when allowInteractive is set", () => {
    // The image case: the <button> IS the intended long-press target, so the
    // guard that protects a container from its nested controls must lift.
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress, { allowInteractive: true }));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { target: interactiveTarget })));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("disarms on an early pointercancel — a scroll whose moves never reached us", () => {
    // The browser suppresses pointermoves inside its own slop and fires
    // `pointercancel` the moment it claims the pan, so a scroll arrives here
    // with no drift on record. Leaving the timer armed opens the menu
    // mid-scroll.
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { timeStamp: 1000 })));
    act(() => result.current.onPointerCancel?.(pointer(100, 100, { timeStamp: 1060 })));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("still drops a pointercancel that follows real movement", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    act(() => result.current.onPointerMove?.(pointer(100, 160)));
    act(() => result.current.onPointerCancel?.(pointer(100, 100)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("fires on release when a stall compressed the dispatch of a real hold", () => {
    // A main-thread stall (e.g. the previous sheet closing) can hold up event
    // processing so a genuine 700ms hold reaches JS as a down+up pair
    // milliseconds apart. The hardware timestamps still carry the true story.
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { timeStamp: 1000 })));
    act(() => void vi.advanceTimersByTime(5));
    act(() => result.current.onPointerUp?.(pointer(100, 100, { timeStamp: 1700 })));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    // ...and the click that follows the release is swallowed, as usual.
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;
    act(() => result.current.onClick?.(click));
    expect(click.preventDefault).toHaveBeenCalled();
  });

  it("a compressed quick tap still does not fire", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { timeStamp: 1000 })));
    act(() => result.current.onPointerUp?.(pointer(100, 100, { timeStamp: 1150 })));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("fires on a stationary pointercancel whose timestamps already span the hold", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { timeStamp: 1000 })));
    act(() => result.current.onPointerCancel?.(pointer(100, 100, { timeStamp: 1600 })));

    expect(onLongPress).toHaveBeenCalledTimes(1);
    // The timer must be dead: no double fire later.
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));
    expect(onLongPress).toHaveBeenCalledTimes(1);
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

  it("disarms when an ancestor captures the pointer and drags the gesture away", () => {
    // The pane's swipe recognizer claims the reveal 10px in — under this
    // hook's own slop — and takes pointer capture, after which the row's
    // handlers see nothing more of the touch. Watching the window instead
    // keeps the sheet from opening on a message the thumb was only resting on.
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { pointerId: 7 })));
    // No further element-level events: the stream now belongs to the pane.
    act(() => dispatchWindowPointer("pointermove", 180, 104, { pointerId: 7 }));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("ignores a second finger's stream while a hold is armed", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { pointerId: 7 })));
    act(() => dispatchWindowPointer("pointermove", 300, 300, { pointerId: 8 }));
    act(() => dispatchWindowPointer("pointerup", 300, 300, { pointerId: 8 }));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("stops watching the window once the press is over", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() => result.current.onPointerDown?.(pointer(100, 100, { pointerId: 7, timeStamp: 1000 })));
    act(() => result.current.onPointerUp?.(pointer(100, 100, { pointerId: 7, timeStamp: 1100 })));
    // A stray move from an unrelated gesture must not reach the disarmed hold.
    act(() => dispatchWindowPointer("pointermove", 400, 400, { pointerId: 7 }));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does nothing at all without a callback", () => {
    const { result } = renderHook(() => useLongPress(undefined));
    act(() => result.current.onPointerDown?.(pointer(100, 100)));
    act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
    // No throw is the assertion.
    expect(result.current.onPointerDown).toBeTypeOf("function");
  });
});
