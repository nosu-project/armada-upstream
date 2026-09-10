import { describe, expect, it } from "vitest";

import { extractInstagramShortcode, extractStreamableId } from "@/lib/linkEmbed";

describe("extractInstagramShortcode", () => {
  it("reads the shortcode from a post URL", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/p/CxYz-123_ab/")).toBe(
      "CxYz-123_ab",
    );
  });

  it("handles reels, reels-plural and IGTV paths", () => {
    expect(extractInstagramShortcode("https://instagram.com/reel/AbC123/")).toBe("AbC123");
    expect(extractInstagramShortcode("https://instagram.com/reels/AbC123/")).toBe("AbC123");
    expect(extractInstagramShortcode("https://instagram.com/tv/AbC123/")).toBe("AbC123");
  });

  it("handles the profile-prefixed form", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/someuser/p/CxYz123/")).toBe(
      "CxYz123",
    );
  });

  it("accepts m., instagr.am and the front-end mirrors", () => {
    expect(extractInstagramShortcode("https://m.instagram.com/p/CxYz123/")).toBe("CxYz123");
    expect(extractInstagramShortcode("https://instagr.am/p/CxYz123/")).toBe("CxYz123");
    expect(extractInstagramShortcode("https://ddinstagram.com/p/CxYz123/")).toBe("CxYz123");
    expect(extractInstagramShortcode("https://instagramez.com/p/CxYz123/")).toBe("CxYz123");
  });

  it("returns null for non-post Instagram URLs and other hosts", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/someuser/")).toBeNull();
    expect(extractInstagramShortcode("https://www.instagram.com/")).toBeNull();
    expect(extractInstagramShortcode("https://example.com/p/CxYz123/")).toBeNull();
    expect(extractInstagramShortcode("not a url")).toBeNull();
  });
});

describe("extractStreamableId", () => {
  it("reads the id from a share URL", () => {
    expect(extractStreamableId("https://streamable.com/abc123")).toBe("abc123");
    expect(extractStreamableId("https://www.streamable.com/abc123")).toBe("abc123");
  });

  it("reads the id from an embed URL", () => {
    expect(extractStreamableId("https://streamable.com/e/abc123")).toBe("abc123");
  });

  it("ignores trailing path and query", () => {
    expect(extractStreamableId("https://streamable.com/abc123?t=5")).toBe("abc123");
    expect(extractStreamableId("https://streamable.com/e/abc123/")).toBe("abc123");
  });

  it("returns null for other hosts and non-URLs", () => {
    expect(extractStreamableId("https://example.com/abc123")).toBeNull();
    expect(extractStreamableId("https://streamable.com/")).toBeNull();
    expect(extractStreamableId("not a url")).toBeNull();
  });
});
