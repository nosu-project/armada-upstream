// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocalStorage } from "@/hooks/useLocalStorage";

beforeEach(() => localStorage.clear());

describe("useLocalStorage", () => {
  it("composes functional updates made before a render", () => {
    const { result } = renderHook(() => useLocalStorage("k", 0));
    act(() => {
      result.current[1]((n) => n + 1);
      result.current[1]((n) => n + 1);
    });
    expect(result.current[0]).toBe(2);
    expect(localStorage.getItem("k")).toBe("2");
  });

  it("runs an unchanged update once and neither writes nor re-renders", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useLocalStorage("k", { a: 1 });
    });
    const before = renders;
    const updater = vi.fn((v: { a: number }) => v);
    act(() => result.current[1](updater));
    expect(updater).toHaveBeenCalledTimes(1);
    expect(renders).toBe(before);
    expect(localStorage.getItem("k")).toBeNull();
  });

  it("builds on a value synced from another tab", () => {
    const { result } = renderHook(() => useLocalStorage("k", 0));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "k", newValue: "5" }));
    });
    expect(result.current[0]).toBe(5);
    act(() => result.current[1]((n) => n + 1));
    expect(result.current[0]).toBe(6);
  });
});
