import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useIsTouch } from "./useIsMobile";

/** A device whose media features are `features`; any other query fails. */
function stubDevice(features: string[]) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: features.some((f) => query === `(${f})`),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIsTouch", () => {
  it("treats a phone whose WebView also reports hover as touch", () => {
    // Some Android WebViews: coarse primary pointer, yet `hover: hover`.
    stubDevice(["pointer: coarse", "hover: hover"]);
    expect(renderHook(() => useIsTouch()).result.current).toBe(true);
  });

  it("keeps a mouse-driven desktop as non-touch", () => {
    stubDevice(["pointer: fine", "hover: hover"]);
    expect(renderHook(() => useIsTouch()).result.current).toBe(false);
  });
});
