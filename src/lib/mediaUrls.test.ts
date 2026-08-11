import { describe, expect, it } from "vitest";

import { isGifLikeUrl } from "./mediaUrls";

describe("isGifLikeUrl", () => {
  it("matches Tenor and Giphy media hosts (and subdomains)", () => {
    expect(isGifLikeUrl("https://media.tenor.com/abc123/reaction.mp4")).toBe(true);
    expect(isGifLikeUrl("https://media1.giphy.com/media/xyz/giphy.mp4")).toBe(true);
    expect(isGifLikeUrl("https://c.tenor.com/abc/AAAAC/thing.webm")).toBe(true);
    expect(isGifLikeUrl("https://tenor.com/view/foo.mp4")).toBe(true);
  });

  it("matches the .gif.mp4 / .gif.webm filename convention on any host", () => {
    expect(isGifLikeUrl("https://blossom.example/cat.gif.mp4")).toBe(true);
    expect(isGifLikeUrl("https://blossom.example/cat.gif.webm")).toBe(true);
  });

  it("does not match ordinary videos", () => {
    expect(isGifLikeUrl("https://blossom.example/clip.mp4")).toBe(false);
    expect(isGifLikeUrl("https://cdn.example.com/movie.webm")).toBe(false);
  });

  it("does not match a lookalike host", () => {
    expect(isGifLikeUrl("https://nottenor.com/x.mp4")).toBe(false);
    expect(isGifLikeUrl("https://tenor.com.evil.example/x.mp4")).toBe(false);
  });

  it("returns false for an unparseable URL", () => {
    expect(isGifLikeUrl("not a url")).toBe(false);
  });
});
