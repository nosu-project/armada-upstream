import { describe, expect, it } from "vitest";

import {
  extractInstagramShortcode,
  extractStreamableId,
  giphyMp4FromPageUrl,
  isTenorPageUrl,
  tenorMp4FromThumbnail,
} from "@/lib/linkEmbed";

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

describe("Tenor page links", () => {
  it("recognizes tenor.com/view pages, with or without a locale", () => {
    expect(isTenorPageUrl("https://tenor.com/view/mbison-bison-street-fighter-yes-anime-gif-3830858880492276737")).toBe(true);
    expect(isTenorPageUrl("https://tenor.com/en-GB/view/foo-gif-123")).toBe(true);
    expect(isTenorPageUrl("https://tenor.com/search/cats")).toBe(false);
    expect(isTenorPageUrl("https://nottenor.com/view/foo-gif-123")).toBe(false);
  });

  it("derives the MP4 from the preview proxy's wrapped thumbnail", () => {
    expect(
      tenorMp4FromThumbnail(
        "https://api.ditto.pub/link-preview-image/https%3A%2F%2Fmedia.tenor.com%2FNSnx2uRkjAEAAAAN%2Fmbison-bison.png",
      ),
    ).toBe("https://media.tenor.com/NSnx2uRkjAEAAAPo/mbison-bison.mp4");
  });

  it("derives the MP4 from a bare media thumbnail, incl. the /m/ form", () => {
    expect(tenorMp4FromThumbnail("https://media1.tenor.com/m/NSnx2uRkjAEAAAAC/mbison-bison.gif"))
      .toBe("https://media.tenor.com/NSnx2uRkjAEAAAPo/mbison-bison.mp4");
  });

  it("refuses thumbnails that are not Tenor media", () => {
    expect(tenorMp4FromThumbnail("https://example.com/NSnx2uRkjAEAAAAN/x.png")).toBeNull();
    expect(tenorMp4FromThumbnail(undefined)).toBeNull();
  });
});

describe("giphyMp4FromPageUrl", () => {
  it("derives the MP4 from a gif page's id", () => {
    expect(giphyMp4FromPageUrl("https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S"))
      .toBe("https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4");
    expect(giphyMp4FromPageUrl("https://giphy.com/gifs/JIX9t2j0ZTN9S"))
      .toBe("https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4");
    expect(giphyMp4FromPageUrl("https://giphy.com/explore/cats")).toBeNull();
  });
});
