import { focusManager } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useResumeEpoch } from "./useResumeEpoch";

const AWAY_MS = 30_000;

/** Background the app, wait `awayMs` of wall clock, then bring it back. */
function backgroundFor(awayMs: number): void {
  act(() => {
    focusManager.setFocused(false);
  });
  vi.advanceTimersByTime(awayMs);
  act(() => {
    focusManager.setFocused(true);
  });
}

afterEach(() => {
  vi.useRealTimers();
  // Hand focus tracking back to the default (document visibility) listener.
  focusManager.setFocused(undefined);
});

describe("useResumeEpoch", () => {
  it("starts at zero", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useResumeEpoch(AWAY_MS));
    expect(result.current).toBe(0);
  });

  it("bumps when the app returns after a long enough absence", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useResumeEpoch(AWAY_MS));

    backgroundFor(AWAY_MS);

    expect(result.current).toBe(1);
  });

  it("does not bump for a brief alt-tab", () => {
    // A standing subscription missed nothing in two seconds, and tearing it
    // down and rebuilding it on every glance at another window is pure cost.
    vi.useFakeTimers();
    const { result } = renderHook(() => useResumeEpoch(AWAY_MS));

    backgroundFor(2_000);

    expect(result.current).toBe(0);
  });

  it("counts each qualifying resume separately", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useResumeEpoch(AWAY_MS));

    backgroundFor(AWAY_MS);
    backgroundFor(AWAY_MS * 2);

    expect(result.current).toBe(2);
  });

  it("measures the away time, not the time since the last resume", () => {
    // Long uptime followed by a short background must still be a no-op.
    vi.useFakeTimers();
    const { result } = renderHook(() => useResumeEpoch(AWAY_MS));

    vi.advanceTimersByTime(AWAY_MS * 10);
    backgroundFor(1_000);

    expect(result.current).toBe(0);
  });

  it("stops listening once unmounted", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useResumeEpoch(AWAY_MS));

    unmount();
    backgroundFor(AWAY_MS);

    expect(result.current).toBe(0);
  });
});
