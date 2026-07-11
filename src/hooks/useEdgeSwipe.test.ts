import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Silence the act() warnings in the stale-state test — NOT wrapping the
// move→up sequence in act() is the entire point: it simulates pointerup
// firing before React flushes the setState from pointermove.
const originalError = console.error;
beforeEach(() => {
  console.error = (...args: unknown[]) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("not wrapped in act")) return;
    originalError(...args);
  };
});
afterEach(() => {
  console.error = originalError;
});

import { useEdgeSwipe } from "@/hooks/useEdgeSwipe";

// ─── Mock pointer events (jsdom has no PointerEvent) ─────────────────────

interface MockPointerOpts {
  x: number;
  y: number;
  pointerId?: number;
  pointerType?: string;
  timeStamp?: number;
  cancelable?: boolean;
  target?: EventTarget | null;
  currentTarget?: HTMLElement;
}

function mockPointerEvent(opts: MockPointerOpts) {
  const el =
    opts.currentTarget ??
    (Object.assign(document.createElement("div"), {
      getBoundingClientRect: () => ({ width: 400, left: 0, right: 400, top: 0, bottom: 800, height: 800, x: 0, y: 0, toJSON: () => ({}) }),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    }) as Partial<HTMLElement> as HTMLElement);

  return {
    pointerId: opts.pointerId ?? 1,
    pointerType: opts.pointerType ?? "touch",
    clientX: opts.x,
    clientY: opts.y,
    timeStamp: opts.timeStamp ?? 0,
    cancelable: opts.cancelable ?? true,
    target: opts.target ?? el,
    currentTarget: el,
    preventDefault: vi.fn(),
  } as unknown as React.PointerEvent;
}

function makeEl(width = 400): HTMLElement {
  return Object.assign(document.createElement("div"), {
    getBoundingClientRect: () => ({
      width,
      left: 0,
      right: width,
      top: 0,
      bottom: 800,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  }) as Partial<HTMLElement> as HTMLElement;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("useEdgeSwipe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());
  it("commits when a rightward drag passes the commit fraction of the pane width", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit }));
    const el = makeEl(400);

    const h = result.current.handlers;
    // threshold is 25% of 400 = 100px; drag 150px to clear it comfortably
    act(() => h.onPointerDown(mockPointerEvent({ x: 0, y: 0, timeStamp: 0, currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 150, y: 0, timeStamp: 100, currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 150, y: 0, timeStamp: 100, currentTarget: el })));

    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("does NOT commit when the drag falls short of the threshold", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit }));
    const el = makeEl(400);

    // 25% of 400 = 100px; drag only 50px (below threshold), zero velocity
    const h = result.current.handlers;
    act(() => h.onPointerDown(mockPointerEvent({ x: 0, y: 0, timeStamp: 0, currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 50, y: 0, timeStamp: 500, currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 50, y: 0, timeStamp: 500, currentTarget: el })));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits on a fast flick even if the distance is short (velocity threshold)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit }));
    const el = makeEl(400);

    // velocity threshold is 0.3 px/ms. Move 50px in 50ms = 1.0 px/ms.
    // 50px < 100px (25% of 400), so only velocity can carry this commit.
    const h = result.current.handlers;
    act(() => h.onPointerDown(mockPointerEvent({ x: 0, y: 0, timeStamp: 0, currentTarget: el })));
    // First move past claim threshold (10px) to claim the gesture
    act(() => h.onPointerMove(mockPointerEvent({ x: 15, y: 0, timeStamp: 10, currentTarget: el })));
    // Fast flick to 50px
    act(() => h.onPointerMove(mockPointerEvent({ x: 50, y: 0, timeStamp: 50, currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 50, y: 0, timeStamp: 50, currentTarget: el })));

    expect(onCommit).toHaveBeenCalledOnce();
  });

  // ─── The primary fix: stale dragX race ──────────────────────────────────
  //
  // On a quick flick, `pointerup` can fire before React has flushed the
  // `setState` from the final `pointermove`. The `finish` handler captured in
  // the closure of the pre-move render would then read a stale `state.dragX`
  // (0 or an older value) and silently drop the commit. The fix mirrors
  // dragX into a ref (`dragXRef`) updated synchronously in `onPointerMove`,
  // so `finish` always sees the latest value regardless of React's render
  // timing.
  it("commits by distance even when pointerup fires before React re-renders (stale state race)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit }));
    const el = makeEl(400);

    // Capture handlers from the INITIAL render (before any setState flushes).
    // In the old code, `finish` was a useCallback with `state.dragX` in its
    // deps — the first render's `finish` captured `state.dragX = 0`. The
    // new code reads `dragXRef.current` which is updated synchronously in
    // `onPointerMove`, so the first render's `finish` still sees the real
    // final position.
    const h = result.current.handlers;

    // Drive the entire gesture WITHOUT letting React flush state updates
    // between move and up (no act() wrapper around the move→up sequence).
    // This simulates a synchronous flick where the browser dispatches
    // pointermove then pointerup before React can re-render.
    //
    // Use a SLOW drag (low velocity, well below the 0.3 px/ms threshold) so
    // the ONLY thing that can carry the commit is the distance check — which
    // reads `state.dragX` (stale=0 in the old code) or `dragXRef.current`
    // (fresh in the new code). This isolates the fix from the velocity ref.
    h.onPointerDown(mockPointerEvent({ x: 0, y: 0, timeStamp: 0, currentTarget: el }));
    h.onPointerMove(mockPointerEvent({ x: 15, y: 0, timeStamp: 1000, currentTarget: el }));
    h.onPointerMove(mockPointerEvent({ x: 200, y: 0, timeStamp: 2000, currentTarget: el }));
    h.onPointerUp(mockPointerEvent({ x: 200, y: 0, timeStamp: 2000, currentTarget: el }));

    // Flush any pending state updates.
    act(() => {});

    // 200px > 100px (25% of 400) → should commit by distance.
    // Velocity = (200-15)/1000 = 0.185 px/ms < 0.3 → velocity can't carry it.
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("ignores mouse pointer type (touch/pen only)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit }));
    const el = makeEl(400);

    const h = result.current.handlers;
    act(() => h.onPointerDown(mockPointerEvent({ x: 0, y: 0, pointerType: "mouse", currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 200, y: 0, pointerType: "mouse", currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 200, y: 0, pointerType: "mouse", currentTarget: el })));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects a vertical-dominant drag (lets the scroller handle it)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit }));
    const el = makeEl(400);

    const h = result.current.handlers;
    act(() => h.onPointerDown(mockPointerEvent({ x: 0, y: 0, timeStamp: 0, currentTarget: el })));
    // dy (60) > dx (20) * 1.5 (=30) and dy > 10 → permanently rejected
    act(() => h.onPointerMove(mockPointerEvent({ x: 20, y: 60, timeStamp: 10, currentTarget: el })));
    // Even a large subsequent horizontal move won't commit (rejected flag set)
    act(() => h.onPointerMove(mockPointerEvent({ x: 300, y: 60, timeStamp: 20, currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 300, y: 60, timeStamp: 20, currentTarget: el })));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does NOT reject a slightly diagonal drag (1.5x relaxation)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit }));
    const el = makeEl(400);

    const h = result.current.handlers;
    // dy (20) is > dx (15) but NOT > dx*1.5 (=22.5), so the claim test
    // doesn't reject. The gesture should still claim once dx > 10px.
    act(() => h.onPointerDown(mockPointerEvent({ x: 0, y: 0, timeStamp: 0, currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 15, y: 20, timeStamp: 10, currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 200, y: 25, timeStamp: 60, currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 200, y: 25, timeStamp: 60, currentTarget: el })));

    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("does nothing when disabled", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() => useEdgeSwipe({ onCommit, enabled: false }));
    const el = makeEl(400);

    const h = result.current.handlers;
    act(() => h.onPointerDown(mockPointerEvent({ x: 0, y: 0, currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 200, y: 0, currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 200, y: 0, currentTarget: el })));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("works for the close direction (leftward drag)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useEdgeSwipe({ onCommit, direction: "close" }),
    );
    const el = makeEl(400);

    // Close: sign = -1, so progress = (clientX - startX) * -1.
    // Start at x=400, drag leftward to x=200 → dx = (200-400)*-1 = 200px progress.
    // 25% of 400 = 100px threshold; 200px clears it.
    const h = result.current.handlers;
    act(() => h.onPointerDown(mockPointerEvent({ x: 400, y: 0, timeStamp: 0, currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 385, y: 0, timeStamp: 10, currentTarget: el })));
    act(() => h.onPointerMove(mockPointerEvent({ x: 200, y: 0, timeStamp: 60, currentTarget: el })));
    act(() => h.onPointerUp(mockPointerEvent({ x: 200, y: 0, timeStamp: 60, currentTarget: el })));

    expect(onCommit).toHaveBeenCalledOnce();
  });
});
