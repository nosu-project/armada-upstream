// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDelayedFlag } from "@/hooks/useDelayedFlag";

describe("useDelayedFlag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays false when active resolves before the delay (no skeleton flash)", () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 200), {
      initialProps: { active: true },
    });
    expect(result.current).toBe(false);
    // Data arrives after 50ms — well under the 200ms delay.
    act(() => void vi.advanceTimersByTime(50));
    rerender({ active: false });
    act(() => void vi.advanceTimersByTime(500));
    expect(result.current).toBe(false);
  });

  it("becomes true once active persists past the delay", () => {
    const { result } = renderHook(() => useDelayedFlag(true, 200));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(199));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("resets immediately when active goes false", () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 200), {
      initialProps: { active: true },
    });
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toBe(true);
    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  it("restarts the delay if active flickers off then on", () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 200), {
      initialProps: { active: true },
    });
    act(() => void vi.advanceTimersByTime(150));
    rerender({ active: false });
    rerender({ active: true });
    // Only 150ms of the *new* continuous run has to elapse from scratch.
    act(() => void vi.advanceTimersByTime(150));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(50));
    expect(result.current).toBe(true);
  });
});
