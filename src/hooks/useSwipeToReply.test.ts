import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useSwipeToReply } from "@/hooks/useSwipeToReply";

/**
 * Minimal touch-event factory. Only the fields the hook reads.
 */
function touch(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as React.TouchEvent;
}

describe("useSwipeToReply", () => {
  it("calls onSwipe when horizontal drag exceeds threshold", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, true));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, 200));
    });
    act(() => {
      // Move 70px right, 5px down — predominantly horizontal.
      result.current.touchHandlers.onTouchMove(touch(170, 205));
    });
    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onSwipe below threshold", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, true));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, 200));
    });
    act(() => {
      // Only 30px right — not enough.
      result.current.touchHandlers.onTouchMove(touch(130, 202));
    });
    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("ignores predominantly vertical gestures", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, true));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, 200));
    });
    act(() => {
      // 10px right, 100px down — vertical scroll.
      result.current.touchHandlers.onTouchMove(touch(110, 300));
    });
    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    expect(onSwipe).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
  });

  it("does nothing when disabled", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, false));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, 200));
    });
    act(() => {
      result.current.touchHandlers.onTouchMove(touch(200, 200));
    });
    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    expect(onSwipe).not.toHaveBeenCalled();
    expect(result.current.offset).toBe(0);
  });

  it("resets offset to 0 after release", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, true));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, 200));
    });
    act(() => {
      result.current.touchHandlers.onTouchMove(touch(170, 205));
    });

    // During drag, offset is non-zero.
    expect(result.current.offset).toBe(70);

    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    // After release, springs back to 0.
    expect(result.current.offset).toBe(0);
  });
});
