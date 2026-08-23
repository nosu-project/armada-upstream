// @vitest-environment jsdom
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
  it("calls onSwipe when a leftward drag exceeds the threshold", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, true));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(200, 200));
    });
    act(() => {
      // Move 70px left, 5px down — predominantly horizontal.
      result.current.touchHandlers.onTouchMove(touch(130, 205));
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
      result.current.touchHandlers.onTouchStart(touch(200, 200));
    });
    act(() => {
      // Only 30px left — not enough.
      result.current.touchHandlers.onTouchMove(touch(170, 202));
    });
    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("ignores a rightward drag (belongs to the pane-reveal 'leave room' gesture)", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, true));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, 200));
    });
    act(() => {
      // 70px right — the SwipeReveal edge-swipe direction, not reply.
      result.current.touchHandlers.onTouchMove(touch(170, 205));
    });

    // No visual feedback either — the row must not slide while the pane drags.
    expect(result.current.offset).toBe(0);
    expect(result.current.dragging).toBe(false);

    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("stays bailed out if a rightward drag later reverses leftward", () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useSwipeToReply(onSwipe, true));

    act(() => {
      result.current.touchHandlers.onTouchStart(touch(100, 200));
    });
    act(() => {
      result.current.touchHandlers.onTouchMove(touch(170, 202)); // rightward → bail
    });
    act(() => {
      result.current.touchHandlers.onTouchMove(touch(20, 202)); // now far left
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
      result.current.touchHandlers.onTouchStart(touch(200, 200));
    });
    act(() => {
      // 10px left, 100px down — vertical scroll.
      result.current.touchHandlers.onTouchMove(touch(190, 300));
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
      result.current.touchHandlers.onTouchStart(touch(200, 200));
    });
    act(() => {
      result.current.touchHandlers.onTouchMove(touch(100, 200));
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
      result.current.touchHandlers.onTouchStart(touch(200, 200));
    });
    act(() => {
      result.current.touchHandlers.onTouchMove(touch(130, 205));
    });

    // During drag, offset is the positive leftward magnitude.
    expect(result.current.offset).toBe(70);

    act(() => {
      result.current.touchHandlers.onTouchEnd();
    });

    // After release, springs back to 0.
    expect(result.current.offset).toBe(0);
  });
});
