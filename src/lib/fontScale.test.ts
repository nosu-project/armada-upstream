// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { FONT_SCALE_KEY, getFontScale, setFontScale } from "@/lib/fontScale";

describe("fontScale", () => {
  afterEach(() => setFontScale(100));

  it("stores the size and applies it to <html>", () => {
    setFontScale(125);
    expect(getFontScale()).toBe(125);
    expect(localStorage.getItem(FONT_SCALE_KEY)).toBe("125");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.25");
  });

  it("clears both at the default, leaving text at its designed size", () => {
    setFontScale(120);
    setFontScale(100);
    expect(localStorage.getItem(FONT_SCALE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("");
  });

  it("clamps out-of-range sizes", () => {
    setFontScale(400);
    expect(getFontScale()).toBe(150);
    setFontScale(10);
    expect(getFontScale()).toBe(80);
  });
});
