/**
 * Body previews for Git rows. The property under test throughout: whatever the
 * body is, the row's share of the timeline stays about the size of a message.
 */

import { describe, expect, it } from "vitest";

import { gitBodyPreview } from "@/lib/gitSummary";

describe("gitBodyPreview", () => {
  it("keeps a short plain body verbatim", () => {
    const preview = gitBodyPreview("The timer keeps resetting when the tab is hidden.");
    expect(preview.text).toBe("The timer keeps resetting when the tab is hidden.");
    expect(preview.truncated).toBe(false);
  });

  it("drops markdown images and screen recordings, keeping the prose around them", () => {
    const preview = gitBodyPreview(
      "Steps to reproduce:\n\n![before](https://blossom.example/a.png)\n![after](https://blossom.example/b.png)\n\nhttps://blossom.example/screen.mp4\n\nIt drops the last frame.",
    );
    expect(preview.text).toBe("Steps to reproduce: It drops the last frame.");
  });

  it("drops a markdown image whose URL has no extension", () => {
    // Content-addressed upload hosts serve exactly this shape.
    expect(gitBodyPreview("![shot](https://blossom.example/abc123)").text).toBe("");
  });

  it("drops raw <img> and <video> markup", () => {
    expect(gitBodyPreview('<p>See</p><img src="https://x.test/a.png"><video src="https://x.test/b.mp4"></video>').text).toBe("See");
  });

  it("strips markdown structure but keeps the words", () => {
    const preview = gitBodyPreview("## Summary\n\n- **bold** item\n- `code` item\n\n> quoted line\n\n1. first\n\nSee [the docs](https://x.test/docs).");
    expect(preview.text).toBe("Summary bold item code item quoted line first See the docs.");
  });

  it("keeps fenced code as text so a stack-trace-only body still previews", () => {
    const preview = gitBodyPreview("```\nTypeError: undefined is not a function\n  at fold()\n```");
    expect(preview.text).toBe("TypeError: undefined is not a function at fold()");
  });

  it("leaves snake_case identifiers alone", () => {
    expect(gitBodyPreview("call write_opened before read_control_snapshot").text)
      .toBe("call write_opened before read_control_snapshot");
  });

  it("keeps a non-media URL, which is often the whole point of a comment", () => {
    expect(gitBodyPreview("fixed in https://gitworkshop.dev/x/y").text).toBe("fixed in https://gitworkshop.dev/x/y");
  });

  it("truncates on a word boundary and says so", () => {
    const source = "lorem ipsum dolor sit amet ".repeat(40).trim();
    const preview = gitBodyPreview(source);
    expect(preview.truncated).toBe(true);
    // Short enough to commit to about two lines, so "more" comes early.
    expect(preview.text.length).toBeLessThanOrEqual(121);
    expect(preview.text.endsWith("…")).toBe(true);
    // The kept part is a prefix of the body that stops between two words.
    const kept = preview.text.slice(0, -1);
    expect(source.startsWith(kept)).toBe(true);
    expect(source[kept.length]).toBe(" ");
  });

  it("bounds the string itself, not just its rendered height", () => {
    // A megabyte of prose costs a megabyte of DOM behind a CSS line clamp.
    expect(gitBodyPreview("x".repeat(1_000_000)).text.length).toBeLessThan(200);
  });

  it("leaves nothing behind for a body that is only media", () => {
    // The row is then its subject line alone, which is the whole point.
    expect(gitBodyPreview("![a](https://x.test/a.png)\n![b](https://x.test/b.png)\n![c](https://x.test/c.png)").text).toBe("");
  });
});
