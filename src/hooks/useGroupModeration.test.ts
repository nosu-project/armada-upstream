import { describe, expect, it, vi } from "vitest";

import { metadataTags, waitForGroupMetadata } from "@/hooks/useGroupModeration";

import type { NostrEvent } from "@nostrify/nostrify";
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

describe("waitForGroupMetadata", () => {
  const meta = { ...current, tags: [["d", "g"]] } as NostrEvent;

  it("resolves true once the relay serves the group's 39000", async () => {
    const answers: NostrEvent[][] = [[], [meta]];
    const query = vi.fn(async (_filters: unknown[]) => answers.shift() ?? []);
    expect(await waitForGroupMetadata({ query }, "g", "b".repeat(64), [0, 0, 0])).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toEqual([{ kinds: [39000], "#d": ["g"], authors: ["b".repeat(64)], limit: 1 }]);
  });

  it("resolves false when no read ever shows it, treating a failed read as no answer", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error("closed"))
      .mockResolvedValue([{ ...meta, kind: 9007 }]);
    expect(await waitForGroupMetadata({ query }, "g", undefined, [0, 0])).toBe(false);
    expect(query.mock.calls[1][0]).toEqual([{ kinds: [39000], "#d": ["g"], limit: 1 }]);
  });
});
