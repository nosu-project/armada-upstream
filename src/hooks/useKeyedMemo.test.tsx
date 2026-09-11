import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useKeyedMemo } from "@/hooks/useKeyedMemo";

/**
 * The property that reduces switch churn: returning to a recently-seen key with
 * unchanged deps yields the SAME reference (so the downstream memo chain bails),
 * while a real dep change still recomputes (no staleness).
 */
describe("useKeyedMemo", () => {
  it("returns a stable reference across key oscillation (A→B→A)", () => {
    let builds = 0;
    const { result, rerender } = renderHook(
      ({ key, dep }: { key: string; dep: object }) =>
        useKeyedMemo(key, () => { builds++; return { key, dep }; }, [dep]),
      { initialProps: { key: "A", dep: { a: 1 } } },
    );
    const aDep = { a: 1 };
    rerender({ key: "A", dep: aDep });
    const firstA = result.current;
    const buildsAfterA = builds;

    rerender({ key: "B", dep: { b: 1 } });
    // Switch back to A with the SAME dep identity it last had.
    rerender({ key: "A", dep: aDep });

    // A came back from cache — identical reference, no rebuild.
    expect(result.current).toBe(firstA);
    expect(builds).toBe(buildsAfterA + 1); // only the B build happened in between
  });

  it("recomputes when a key's deps change (never returns a stale value)", () => {
    const { result, rerender } = renderHook(
      ({ dep }: { dep: number }) => useKeyedMemo("A", () => ({ dep }), [dep]),
      { initialProps: { dep: 1 } },
    );
    const first = result.current;
    rerender({ dep: 2 });
    expect(result.current).not.toBe(first);
    expect(result.current.dep).toBe(2);
  });

  it("evicts the oldest key beyond the cap", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useKeyedMemo(key, () => ({ key }), [], 2),
      { initialProps: { key: "A" } },
    );
    const firstA = result.current;
    rerender({ key: "B" });
    rerender({ key: "C" }); // cap 2 → A evicted
    rerender({ key: "A" }); // rebuilt, new reference
    expect(result.current).not.toBe(firstA);
  });
});
