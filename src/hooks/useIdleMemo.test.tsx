import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useIdleMemo } from "@/hooks/useIdleMemo";

/** jsdom has no requestIdleCallback, so the hook falls back to a 0ms timer. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));

describe("useIdleMemo", () => {
  it("computes after commit, not during render", async () => {
    let builds = 0;
    const { result } = renderHook(() => useIdleMemo("A", () => ++builds, []));
    // The render itself returned nothing and ran no compute.
    expect(result.current).toBeUndefined();
    await settle();
    expect(result.current).toBe(1);
    expect(builds).toBe(1);
  });

  it("recomputes when a dep changes and keeps the previous value until it lands", async () => {
    const { result, rerender } = renderHook(
      ({ dep }: { dep: number }) => useIdleMemo("A", () => ({ dep }), [dep]),
      { initialProps: { dep: 1 } },
    );
    await settle();
    const first = result.current;
    expect(first?.dep).toBe(1);
    rerender({ dep: 2 });
    // Still the old value on the very next render — the compute is deferred.
    expect(result.current).toBe(first);
    await settle();
    expect(result.current?.dep).toBe(2);
  });

  it("resets to undefined the moment the key changes, so one key's value never renders under another", async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useIdleMemo(key, () => ({ key }), []),
      { initialProps: { key: "A" } },
    );
    await settle();
    expect(result.current?.key).toBe("A");
    rerender({ key: "B" });
    expect(result.current).toBeUndefined();
    await settle();
    expect(result.current?.key).toBe("B");
  });
});
