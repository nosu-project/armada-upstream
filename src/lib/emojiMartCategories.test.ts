/**
 * Pins the emoji-mart behaviour `syncEmojiMartCategories` exists to work
 * around, so a dependency bump that changes it fails here rather than silently
 * freezing the picker's pack sections at whatever existed on first open.
 */

import data from "@emoji-mart/data";
import { Data, init } from "emoji-mart";
import { describe, expect, it } from "vitest";

import { syncEmojiMartCategories, type EmojiMartCustomCategory } from "@/lib/emojiMartCategories";

function pack(id: string, emojiIds: string[]): EmojiMartCustomCategory {
  return {
    id,
    name: `Pack ${id}`,
    emojis: emojiIds.map((e) => ({ id: e, name: e, keywords: [], skins: [{ src: `https://e/${e}.png` }] })),
  };
}

function categoryIds(): string[] {
  return (Data.categories as { id: string }[]).map((c) => c.id);
}

async function initWith(custom: EmojiMartCustomCategory[]) {
  syncEmojiMartCategories(custom);
  await init({
    data,
    custom,
    set: "native",
    categories: ["frequent", ...custom.map((c) => c.id), "people"],
  });
}

describe("syncEmojiMartCategories", () => {
  it("keeps a pack added after the first init visible, with fresh contents", async () => {
    // First open: one pack.
    await initWith([pack("pack-a", ["a1"])]);
    expect(categoryIds()).toContain("pack-a");

    // The user adds a second pack and gains an emoji in the first. Without the
    // sync, emoji-mart's `categories` filter reads a stale table and pack-b is
    // dropped entirely.
    await initWith([pack("pack-a", ["a1", "a2"]), pack("pack-b", ["b1"])]);

    expect(categoryIds()).toContain("pack-a");
    expect(categoryIds()).toContain("pack-b");
    const packA = (Data.categories as { id: string; emojis: unknown[] }[]).find((c) => c.id === "pack-a");
    expect(packA?.emojis).toHaveLength(2);
  });

  it("drops a pack the user has removed", async () => {
    await initWith([pack("pack-a", ["a1"]), pack("pack-b", ["b1"])]);
    await initWith([pack("pack-a", ["a1"])]);

    expect(categoryIds()).toContain("pack-a");
    expect(categoryIds()).not.toContain("pack-b");
  });

  it("orders packs where the caller asked, ahead of the standard categories", async () => {
    await initWith([pack("pack-a", ["a1"])]);
    expect(categoryIds().indexOf("pack-a")).toBeLessThan(categoryIds().indexOf("people"));
  });
});
