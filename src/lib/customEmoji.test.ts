import { describe, expect, it } from "vitest";

import { isRenderableReactionKey } from "./customEmoji";

describe("isRenderableReactionKey", () => {
  it("renders unicode emoji", () => {
    expect(isRenderableReactionKey("👍")).toBe(true);
    expect(isRenderableReactionKey("❤️")).toBe(true);
    expect(isRenderableReactionKey("🇺🇸")).toBe(true); // flag (regional indicators)
    expect(isRenderableReactionKey("👨‍👩‍👧‍👦")).toBe(true); // ZWJ family sequence
  });

  it("renders custom emoji shortcodes only with a resolved url", () => {
    expect(isRenderableReactionKey(":soapbox:", "https://example.com/e.png")).toBe(true);
    expect(isRenderableReactionKey(":soapbox:")).toBe(false);
    expect(isRenderableReactionKey(":soapbox:", "")).toBe(false);
  });

  it("rejects raw URLs pasted as reaction content", () => {
    expect(isRenderableReactionKey("https://example.com/some/very/long/path/that/does/not/resolve.png")).toBe(false);
    expect(isRenderableReactionKey("http://foo.bar")).toBe(false);
    expect(isRenderableReactionKey("www.example.com")).toBe(false);
    expect(isRenderableReactionKey("wss://relay.example.com")).toBe(false);
  });

  it("rejects whitespace and long junk text", () => {
    expect(isRenderableReactionKey("")).toBe(false);
    expect(isRenderableReactionKey("this is not an emoji")).toBe(false);
    expect(isRenderableReactionKey("looooooooong")).toBe(false);
  });
});
