import { describe, expect, it } from "vitest";

import { hasStrippableMetadata, isAnimatedImage } from "./imageMetadata";

/** Assemble a JPEG from `[marker, payload]` segments after the SOI. */
function jpeg(segments: [number, number[]][], trailing: number[] = [0xff, 0xda]): Uint8Array {
  const bytes: number[] = [0xff, 0xd8];
  for (const [marker, payload] of segments) {
    const length = payload.length + 2;
    bytes.push(0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload);
  }
  bytes.push(...trailing);
  return new Uint8Array(bytes);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

describe("hasStrippableMetadata", () => {
  it("detects an EXIF APP1 segment", () => {
    // What a phone camera emits, GPS and all.
    const file = jpeg([[0xe1, ascii("Exif\0\0MM\0*")]]);
    expect(hasStrippableMetadata(file)).toBe(true);
  });

  it("detects EXIF that follows a JFIF header", () => {
    const file = jpeg([
      [0xe0, ascii("JFIF\0")],
      [0xe1, ascii("Exif\0\0")],
    ]);
    expect(hasStrippableMetadata(file)).toBe(true);
  });

  it("detects an IPTC/Photoshop APP13 segment", () => {
    expect(hasStrippableMetadata(jpeg([[0xed, ascii("Photoshop 3.0")]]))).toBe(true);
  });

  it("detects a comment segment", () => {
    expect(hasStrippableMetadata(jpeg([[0xfe, ascii("created with something")]]))).toBe(true);
  });

  it("passes a JFIF-only JPEG as clean", () => {
    // APP0 is a decoding header, not metadata about the photographer.
    expect(hasStrippableMetadata(jpeg([[0xe0, ascii("JFIF\0")]]))).toBe(false);
  });

  it("passes an Adobe APP14 JPEG as clean", () => {
    expect(hasStrippableMetadata(jpeg([[0xee, ascii("Adobe")]]))).toBe(false);
  });

  it("stops at the start of scan rather than matching image data", () => {
    // Bytes after SOS are entropy-coded and must not be parsed as segments.
    const file = jpeg([[0xe0, ascii("JFIF\0")]], [0xff, 0xda, 0xff, 0xe1, 0x00, 0x08, ...ascii("Exif")]);
    expect(hasStrippableMetadata(file)).toBe(false);
  });

  it("detects a PNG eXIf chunk", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ascii("eXIf")]);
    expect(hasStrippableMetadata(png)).toBe(true);
  });

  it("detects an XMP packet", () => {
    const bytes = new Uint8Array(ascii("RIFF....WEBPhttp://ns.adobe.com/xap/1.0/"));
    expect(hasStrippableMetadata(bytes)).toBe(true);
  });

  it("passes a bare PNG header as clean", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ascii("IHDR")]);
    expect(hasStrippableMetadata(png)).toBe(false);
  });

  it("handles a truncated file without throwing", () => {
    expect(hasStrippableMetadata(new Uint8Array([0xff]))).toBe(false);
    expect(hasStrippableMetadata(new Uint8Array())).toBe(false);
  });

  it("does not loop forever on a malformed segment length", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xe1]);
    expect(hasStrippableMetadata(bytes)).toBe(false);
  });
});

describe("isAnimatedImage", () => {
  it("treats every GIF as animated", () => {
    expect(isAnimatedImage("image/gif", new Uint8Array(ascii("GIF89a")))).toBe(true);
  });

  it("detects an animated WebP by its ANIM chunk", () => {
    const webp = new Uint8Array(ascii("RIFF____WEBPVP8X________ANIM"));
    expect(isAnimatedImage("image/webp", webp)).toBe(true);
  });

  it("treats a still WebP as not animated", () => {
    const webp = new Uint8Array(ascii("RIFF____WEBPVP8 ________"));
    expect(isAnimatedImage("image/webp", webp)).toBe(false);
  });

  it("detects an APNG by its acTL chunk", () => {
    const apng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...ascii("IHDR________acTL________IDAT"),
    ]);
    expect(isAnimatedImage("image/png", apng)).toBe(true);
  });

  it("treats a still PNG as not animated", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...ascii("IHDR________IDAT________acTL"),
    ]);
    // `acTL` after `IDAT` is not an animation control chunk.
    expect(isAnimatedImage("image/png", png)).toBe(false);
  });

  it("treats JPEG as never animated", () => {
    expect(isAnimatedImage("image/jpeg", new Uint8Array([0xff, 0xd8]))).toBe(false);
  });
});
