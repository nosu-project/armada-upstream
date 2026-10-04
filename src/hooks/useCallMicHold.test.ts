// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCallMicHold } from "./useCallMicHold";

const hold = vi.hoisted(() => ({ should: true, fn: vi.fn<() => Promise<() => void>>() }));
vi.mock("@/lib/callMicHold", () => ({
  shouldHoldCallMic: () => hold.should,
  holdCallMic: () => hold.fn(),
}));

describe("useCallMicHold", () => {
  afterEach(() => {
    hold.should = true;
    hold.fn.mockReset();
    vi.restoreAllMocks();
  });

  it("waits for the capture, then releases it on unmount", async () => {
    const release = vi.fn();
    let resolve!: (r: () => void) => void;
    hold.fn.mockReturnValue(new Promise((r) => { resolve = r; }));

    const { result, unmount } = renderHook(() => useCallMicHold());
    expect(result.current).toBe(false);
    await act(async () => resolve(release));
    await waitFor(() => expect(result.current).toBe(true));
    expect(release).not.toHaveBeenCalled();

    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("still connects when the mic is refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hold.fn.mockRejectedValue(new Error("NotAllowedError"));
    const { result } = renderHook(() => useCallMicHold());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("releases a capture that resolves after unmount", async () => {
    const release = vi.fn();
    let resolve!: (r: () => void) => void;
    hold.fn.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { unmount } = renderHook(() => useCallMicHold());
    unmount();
    await act(async () => resolve(release));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is ready at once where nothing is held", () => {
    hold.should = false;
    const { result } = renderHook(() => useCallMicHold());
    expect(result.current).toBe(true);
    expect(hold.fn).not.toHaveBeenCalled();
  });
});
