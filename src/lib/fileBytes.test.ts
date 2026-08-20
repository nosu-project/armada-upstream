import { describe, expect, it } from "vitest";

import { filenameFromUrl, safeFilename, sniffImageMime } from "./fileBytes";

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

  // For media the URL-derived name is the ONLY name, and it lands in a
  // `Filesystem.writeFile` path on native — where neither plugin checks
  // containment. WHATWG parsing pops only LITERAL `..` segments, so an encoded
  // one survives in `pathname` and `decodeURIComponent` restores it.
  describe("a sender-chosen URL cannot become a path", () => {
    const cases: Array<[label: string, url: string]> = [
      ["encoded ../", "https://h.test/%2e%2e%2fdatabases%2farmada.sqlite"],
      ["uppercase encoded ..\\", "https://h.test/%2E%2E%5Cshared_prefs%5Cprefs.xml"],
      ["encoded //", "https://h.test/%2f%2f"],
      ["a bare encoded ..", "https://h.test/%2e%2e"],
      ["an embedded NUL", "https://h.test/a%00b.png"],
      // The extension the media tokenizer wants can sit in the QUERY, which
      // `new URL().pathname` discards — so the traversal needs no extension.
      ["a traversal with the extension in the query", "https://h.test/%2e%2e%2fa.xml?x=y.png"],
      ["a 300-character name", `https://h.test/${"a".repeat(300)}.png`],
      ["a malformed percent-escape", "https://h.test/%zz"],
    ];

    it.each(cases)("%s yields a bare filename", (_label, url) => {
      const name = filenameFromUrl(url, "image/png");
      expect(name).not.toMatch(/[/\\]/);
      expect(name.startsWith(".")).toBe(false);
      // eslint-disable-next-line no-control-regex
      expect(name).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(205);
    });

    it("collapses the traversal rather than dropping the name", () => {
      expect(filenameFromUrl("https://h.test/%2e%2e%2fdatabases%2farmada.sqlite")).toBe(
        "_databases_armada.sqlite",
      );
      // Nothing usable survives a bare "..", so the generic name stands in.
      expect(filenameFromUrl("https://h.test/%2e%2e")).toBe("download");
    });

    it("leaves an ordinary name alone (positive control)", () => {
      expect(filenameFromUrl("https://h.test/holiday.png", "image/png")).toBe("holiday.png");
      expect(filenameFromUrl("https://h.test/a%20b.png")).toBe("a b.png");
    });

    it("agrees with safeFilename, so the two sources cannot drift", () => {
      for (const segment of ["../x.png", "..\\x.png", "a/b.png", "...x.png", "x.png"]) {
        expect(filenameFromUrl(`https://h.test/${encodeURIComponent(segment)}`)).toBe(
          safeFilename(segment),
        );
      }
    });
  });
});

describe("safeFilename", () => {
  it("strips separators, control characters and leading dots", () => {
    expect(safeFilename("../../databases/armada.sqlite")).toBe("_.._databases_armada.sqlite");
    expect(safeFilename("a\u0000b\u001fc\u007f.png")).toBe("abc.png");
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("dir\\file.png")).toBe("dir_file.png");
  });

  it("falls back when nothing usable remains", () => {
    expect(safeFilename(undefined)).toBe("download");
    expect(safeFilename("")).toBe("download");
    expect(safeFilename("...")).toBe("download");
    expect(safeFilename("\u0000")).toBe("download");
  });

  it("caps the length", () => {
    expect(safeFilename("a".repeat(500))).toHaveLength(200);
  });
});
