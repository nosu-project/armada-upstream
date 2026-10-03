import { describe, expect, it } from "vitest";

import { isGifLikeUrl, isUnplayableVideo, mimeFromExt, modelFormat, modelMimeFromExt } from "./mediaUrls";

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

describe("isUnplayableVideo", () => {
  it("flags containers no browser can decode, by extension", () => {
    expect(isUnplayableVideo("https://blossom.example/clip.avi")).toBe(true);
    expect(isUnplayableVideo("https://blossom.example/clip.flv")).toBe(true);
    expect(isUnplayableVideo("https://blossom.example/clip.wmv")).toBe(true);
    expect(isUnplayableVideo("https://blossom.example/clip.mpeg")).toBe(true);
  });

  it("flags them by imeta MIME when the URL is a hash with no extension", () => {
    const url = "https://blossom.example/7bb29464a064aa8c";
    expect(isUnplayableVideo(url, "video/x-msvideo")).toBe(true);
    expect(isUnplayableVideo(url, "video/vnd.avi")).toBe(true);
    expect(isUnplayableVideo(url, "video/x-flv")).toBe(true);
  });

  it("flags a hashed Blossom URL that still carries the .avi extension", () => {
    expect(
      isUnplayableVideo(
        "https://blossom.ditto.pub/7bb29464a064aa8c20402abd0451da2093132.avi",
        "video/vnd.avi",
      ),
    ).toBe(true);
  });

  it("leaves web-playable formats alone", () => {
    expect(isUnplayableVideo("https://blossom.example/clip.mp4", "video/mp4")).toBe(false);
    expect(isUnplayableVideo("https://blossom.example/clip.webm", "video/webm")).toBe(false);
    expect(isUnplayableVideo("https://blossom.example/clip.mov", "video/quicktime")).toBe(false);
    // mkv is intentionally not flagged — Chromium plays it when the codecs fit.
    expect(isUnplayableVideo("https://blossom.example/clip.mkv", "video/x-matroska")).toBe(false);
  });

  it("returns false for non-URLs and missing info", () => {
    expect(isUnplayableVideo("not a url")).toBe(false);
    expect(isUnplayableVideo("")).toBe(false);
  });
});

describe("modelFormat", () => {
  it("reads the format from a model MIME type", () => {
    expect(modelFormat("model/gltf-binary")).toBe("glb");
    expect(modelFormat("MODEL/STL")).toBe("stl");
    expect(modelFormat("model/vnd.collada+xml")).toBe("dae");
  });

  it("falls back to the extension of the name or URL when the MIME says nothing", () => {
    expect(modelFormat("application/octet-stream", "benchy.STL")).toBe("stl");
    expect(modelFormat(undefined, "https://blossom.example/abc123.glb?x=1#y")).toBe("glb");
    expect(modelFormat("", "scene.3mf")).toBe("3mf");
  });

  it("is undefined for anything else", () => {
    expect(modelFormat("application/pdf", "doc.pdf")).toBeUndefined();
    expect(modelFormat("model/step", "part.step")).toBeUndefined();
    expect(modelFormat(undefined, "https://example.com/glb/readme")).toBeUndefined();
  });
});

describe("modelMimeFromExt", () => {
  it("maps drawable model extensions, which mimeFromExt also knows", () => {
    expect(modelMimeFromExt("glb")).toBe("model/gltf-binary");
    expect(modelMimeFromExt("OBJ")).toBe("model/obj");
    expect(mimeFromExt("ply")).toBe("model/x-ply");
    expect(modelMimeFromExt("png")).toBeUndefined();
  });
});
