import { describe, expect, it } from "vitest";

import { getCachedHighlight, highlightAsync } from "./codeHighlight";

describe("highlightAsync", () => {
  it("is a cache miss until highlighted, then answers synchronously with the same tree", async () => {
    expect(getCachedHighlight("json", "{}")).toBeUndefined();
    const tree = await highlightAsync("json", "{}");
    expect(tree).not.toBeNull();
    expect(getCachedHighlight("json", "{}")).toBe(tree);
    expect(await highlightAsync("json", "{}")).toBe(tree);
  });

  it("remembers a negative answer for an unknown language", async () => {
    expect(await highlightAsync("klingon", "x")).toBeNull();
    expect(getCachedHighlight("klingon", "x")).toBeNull();
  });

  it("keys the cache on both language and code", async () => {
    await highlightAsync("json", "[1]");
    expect(getCachedHighlight("yaml", "[1]")).toBeUndefined();
    expect(getCachedHighlight("json", "[1, 2]")).toBeUndefined();
  });
});
