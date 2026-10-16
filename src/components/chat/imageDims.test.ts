import { afterEach, describe, expect, it } from "vitest";

import { clearImageDims, rememberEmbedHeight, rememberImageDim, seenEmbedHeight, seenImageDim } from "./imageDims";

describe("imageDims", () => {
  afterEach(() => clearImageDims());

  it("remembers a loaded image's natural size by URL", () => {
    rememberImageDim("https://x.test/a.png", 1200, 800);
    expect(seenImageDim("https://x.test/a.png")).toBe("1200x800");
    expect(seenImageDim("https://x.test/b.png")).toBeUndefined();
  });

  it("ignores a zero size (a broken or not-yet-decoded image)", () => {
    rememberImageDim("https://x.test/a.png", 0, 0);
    expect(seenImageDim("https://x.test/a.png")).toBeUndefined();
  });

  it("forgets everything on clear, as logout does", () => {
    rememberImageDim("https://x.test/a.png", 10, 10);
    clearImageDims();
    expect(seenImageDim("https://x.test/a.png")).toBeUndefined();
  });

  it("remembers an embed's reported height, and clears it with the images", () => {
    rememberEmbedHeight("tweet:1", 512);
    expect(seenEmbedHeight("tweet:1")).toBe(512);
    rememberEmbedHeight("tweet:1", 0);
    expect(seenEmbedHeight("tweet:1")).toBe(512);
    clearImageDims();
    expect(seenEmbedHeight("tweet:1")).toBeUndefined();
  });
});
