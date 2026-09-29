import { describe, expect, it } from "vitest";

import { metadataTags } from "@/hooks/useGroupModeration";

import type { NostrRumor } from "@/lib/nostrRumor";

const current = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  kind: 39000,
  created_at: 1,
  content: "",
  tags: [
    ["d", "g"],
    ["name", "Old"],
    ["picture", "https://example.com/p.png"],
    ["about", "old about"],
    ["private"],
    ["restricted"],
    ["hidden"],
    ["livekit"],
    ["supported_kinds", "9", "11"],
    ["parent", "root"],
    ["child", "c1"],
    ["child", "c2"],
  ],
} as NostrRumor;

describe("metadataTags (kind 9002)", () => {
  it("carries every field the edit doesn't touch, in order, without the d tag", () => {
    const tags = metadataTags({ name: "New", isPrivate: false, isClosed: true }, current);
    expect(tags).toEqual([
      ["picture", "https://example.com/p.png"],
      ["about", "old about"],
      ["restricted"],
      ["hidden"],
      ["livekit"],
      ["supported_kinds", "9", "11"],
      ["parent", "root"],
      ["child", "c1"],
      ["child", "c2"],
      ["name", "New"],
      ["public"],
      ["visibility", "open"],
      ["closed"],
    ]);
  });

  it("clears restricted/hidden by omitting them", () => {
    const tags = metadataTags({ isRestricted: false, isHidden: false }, current);
    expect(tags).not.toContainEqual(["restricted"]);
    expect(tags).not.toContainEqual(["hidden"]);
    expect(tags).toContainEqual(["private"]);
  });

  it("builds from the patch alone for a new group", () => {
    expect(metadataTags({ name: "Fresh", isClosed: false })).toEqual([["name", "Fresh"], ["open"]]);
  });
});
