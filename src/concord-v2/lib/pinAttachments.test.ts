import { describe, expect, it } from "vitest";

import { pinAttachmentEntries, pinImageRefs } from "@/concord-v2/lib/pinAttachments";

/**
 * Pin attachments come from a member's message and are elevated by a curator,
 * so every URL here is untrusted wire data. The chat timeline sanitizes both
 * imeta paths; these assert pins are not the one renderer that skips it.
 */
const imeta = (...fields: string[]): string[][] => [["imeta", ...fields]];

describe("pinAttachmentEntries", () => {
  it("drops hostile URL schemes rather than handing them to <img>/<a>", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html;base64,PHN2Zz4=", "vbscript:x", "file:///etc/passwd"]) {
      expect(pinAttachmentEntries("", imeta(`url ${bad}`, "m image/png")), bad).toEqual([]);
      expect(pinAttachmentEntries(bad, [])).toEqual([]);
    }
  });

  it("drops local-network hosts, which would prompt every viewer on every open", () => {
    for (const local of ["http://192.168.1.5/x.png", "http://localhost:8080/y.png", "http://127.0.0.1/z.png"]) {
      expect(pinAttachmentEntries("", imeta(`url ${local}`, "m image/png")), local).toEqual([]);
    }
  });

  it("keeps ordinary https attachments, and their imeta detail", () => {
    const entries = pinAttachmentEntries("", imeta("url https://blossom.example/a.png", "m image/png", "size 1234"));
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe("https://blossom.example/a.png");
    expect(pinImageRefs("", imeta("url https://blossom.example/a.png", "m image/png"))).toHaveLength(1);
  });

  it("falls back to bare URLs in content, sanitized the same way", () => {
    expect(pinAttachmentEntries("see https://x.example/pic.jpg", [])).toHaveLength(1);
    expect(pinAttachmentEntries("see javascript:alert(1)/pic.jpg", [])).toEqual([]);
    expect(pinAttachmentEntries("no attachment here", [])).toEqual([]);
  });

  it("classifies images by mime first, extension only when mime is absent", () => {
    expect(pinImageRefs("", imeta("url https://x.example/a", "m image/webp"))).toHaveLength(1);
    expect(pinImageRefs("", imeta("url https://x.example/a.png", "m application/pdf")), "mime wins").toHaveLength(0);
    expect(pinImageRefs("", imeta("url https://x.example/a.png"))).toHaveLength(1);
  });
});
