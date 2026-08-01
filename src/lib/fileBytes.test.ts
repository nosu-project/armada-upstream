import { describe, expect, it } from "vitest";

import { filenameFromUrl, sniffImageMime } from "./fileBytes";

/** Build a header followed by filler, the way a real file starts. */
const head = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(16).fill(0)]);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("sniffImageMime", () => {
  it("identifies the formats a chat attachment actually arrives as", () => {
    expect(sniffImageMime(head(0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageMime(head(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(head(...ascii("GIF89a")))).toBe("image/gif");
    expect(sniffImageMime(head(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")))).toBe("image/webp");
    expect(sniffImageMime(head(0, 0, 0, 0x20, ...ascii("ftypavif")))).toBe("image/avif");
    expect(sniffImageMime(head(0, 0, 0, 0x20, ...ascii("ftypheic")))).toBe("image/heic");
  });

  it("returns undefined rather than guessing at something it doesn't know", () => {
    expect(sniffImageMime(head(...ascii("%PDF-1.7")))).toBeUndefined();
    // A RIFF container that isn't WebP (e.g. a .wav) must not read as one.
    expect(sniffImageMime(head(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")))).toBeUndefined();
    // An ISO-BMFF box with an unrecognized brand.
    expect(sniffImageMime(head(0, 0, 0, 0x20, ...ascii("ftypqt  ")))).toBeUndefined();
  });

  it("does not read past the end of a truncated file", () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    expect(sniffImageMime(new Uint8Array())).toBeUndefined();
  });
});

describe("filenameFromUrl", () => {
  it("appends an extension a sniffed mime supplies when the URL carries none", () => {
    // The Blossom shape: a bare sha256 with nothing to infer a type from.
    expect(filenameFromUrl("https://blossom.test/" + "a".repeat(64), "image/jpeg")).toBe(
      "a".repeat(64) + ".jpg",
    );
  });

  it("falls back to a generic name for a blob: URL", () => {
    expect(filenameFromUrl("blob:https://localhost/1234-5678", "image/png")).toMatch(/\.png$/);
  });

  it("keeps an extension the URL already has", () => {
    expect(filenameFromUrl("https://host.test/photo.webp", "image/webp")).toBe("photo.webp");
  });
});
