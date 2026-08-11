import { describe, expect, it } from "vitest";

import { findEmojiShortcodeColon } from "@/components/chat/EmojiShortcodeAutocomplete";

describe("findEmojiShortcodeColon", () => {
  it("finds a shortcode after whitespace or at the start", () => {
    expect(findEmojiShortcodeColon(":sm", 3)).toBe(0);
    expect(findEmojiShortcodeColon("hi :sm", 6)).toBe(3);
  });

  it("finds a shortcode immediately after a native emoji (no space)", () => {
    const text = "👍:sm";
    expect(findEmojiShortcodeColon(text, text.length)).toBe(text.indexOf(":"));
  });

  it("finds a shortcode after punctuation", () => {
    expect(findEmojiShortcodeColon("ok.:sm", 6)).toBe(3);
  });

  it("rejects colons mid-word (http, times, identifiers)", () => {
    expect(findEmojiShortcodeColon("http://x", 8)).toBe(-1);
    expect(findEmojiShortcodeColon("3:30", 4)).toBe(-1);
    expect(findEmojiShortcodeColon("word:foo", 8)).toBe(-1);
  });

  it("rejects a lone colon with no query yet", () => {
    const text = "👍:";
    expect(findEmojiShortcodeColon(text, text.length)).toBe(-1);
  });
});
