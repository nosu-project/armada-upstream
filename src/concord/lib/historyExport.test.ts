import { describe, expect, it } from "vitest";

import {
  EXPORT_FORMATS,
  buildTranscript,
  escapeHtml,
  exportFileName,
  exportHtml,
  exportHtmlParts,
  exportJson,
  isoTime,
  type ExportModel,
} from "@/concord/lib/historyExport";

function model(over: Partial<ExportModel> = {}): ExportModel {
  return {
    communityName: over.communityName ?? "Test Community",
    communityIdHex: over.communityIdHex ?? "cid1234deadbeef",
    generatedAtMs: over.generatedAtMs ?? Date.parse("2026-01-02T03:04:05.000Z"),
    profiles: over.profiles ?? {
      aa: { pubkey: "aa", name: "Alice", picture: "data:image/png;base64,AAAA" },
      bb: { pubkey: "bb", name: "Bob" },
    },
    channels: over.channels ?? [
      {
        channelIdHex: "ch1",
        name: "general",
        isPrivate: false,
        messages: [
          { rumorId: "m1", author: "aa", ms: Date.parse("2026-01-01T00:00:00Z"), kind: 9, content: "hello world", reactions: [{ emoji: "👍", count: 2 }], attachments: [] },
          { rumorId: "m2", author: "bb", ms: Date.parse("2026-01-01T00:01:00Z"), kind: 9, content: "check https://example.com", edited: true, reactions: [], attachments: [{ url: "https://blossom/x", mime: "image/png", dataUri: "data:image/png;base64,BBBB" }] },
        ],
      },
      { channelIdHex: "ch2", name: "random", isPrivate: true, messages: [] },
    ],
  };
}

describe("isoTime", () => {
  it("formats UTC deterministically", () => {
    expect(isoTime(Date.parse("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("escapeHtml", () => {
  it("neutralizes markup", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });
});

describe("exportJson", () => {
  it("round-trips the model and carries no completeness verdict", () => {
    const parsed = JSON.parse(exportJson(model()));
    expect(parsed.communityName).toBe("Test Community");
    expect(parsed.channels[0].messages).toHaveLength(2);
    expect(parsed.report).toBeUndefined();
  });
});

describe("buildTranscript", () => {
  it("lists channels and messages without a completeness notice", () => {
    const t = buildTranscript(model());
    expect(t).toContain("#general");
    expect(t).toContain("Alice");
    expect(t).toContain("hello world");
    expect(t).not.toMatch(/completeness/i);
  });
});

describe("exportHtml (mini-Armada)", () => {
  it("renders a channel rail and a pane per channel", () => {
    const html = exportHtml(model());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('data-ch="ch1"');
    expect(html).toContain('data-ch="ch2"');
    expect(html).toContain('data-pane="ch1"');
    expect(html).toContain('data-pane="ch2"');
    expect(html).toContain("🔒");
    expect(html).toContain("addEventListener('click'");
  });

  it("carries Chat, Text, and JSON views in one file", () => {
    const html = exportHtml(model());
    expect(html).toContain('data-view="chat"');
    expect(html).toContain('data-view="text"');
    expect(html).toContain('data-view="json"');
    // The Text view embeds the transcript; the JSON view embeds the model.
    expect(html).toContain("#general");
    expect(html).toContain("communityName");
  });

  it("does not bake a completeness notice into the file", () => {
    const html = exportHtml(model());
    expect(html).not.toMatch(/History (INCOMPLETE|complete)/i);
    expect(html).not.toMatch(/completeness/i);
  });

  it("is self-contained: embedded media are data URIs", () => {
    const html = exportHtml(model());
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
  });

  it("does not duplicate embedded media into the JSON view", () => {
    // The base64 lives once in the Chat view; the JSON view keeps URLs only, so
    // a large export can't overflow the max string size by carrying it twice.
    const html = exportHtml(model());
    expect(html.split("data:image/png;base64,BBBB").length - 1).toBe(1);
  });

  it("embeds each avatar once regardless of message count", () => {
    const m = model();
    m.channels[0].messages.push({ rumorId: "m3", author: "aa", ms: Date.parse("2026-01-01T00:02:00Z"), kind: 9, content: "again", reactions: [], attachments: [] });
    const html = exportHtml(m);
    // aa authored two messages, but the avatar bytes appear once (in a style
    // rule) and are referenced by class, not re-inlined per message.
    expect(html.split("data:image/png;base64,AAAA").length - 1).toBe(1);
    expect(html).toContain('class="avatar av-aa"');
  });

  it("builds the file as Blob parts that join to the whole document", () => {
    const parts = exportHtmlParts(model());
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.join("")).toBe(exportHtml(model()));
  });

  it("escapes hostile content so an export can't XSS its viewer", () => {
    const m = model();
    m.channels[0].messages[0].content = "<img src=x onerror=alert(1)>";
    m.profiles.aa.name = "<b>pwn</b>";
    const html = exportHtml(m);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;pwn&lt;/b&gt;");
  });

  it("linkifies bare URLs in content", () => {
    expect(exportHtml(model())).toContain('<a href="https://example.com"');
  });

  it("marks an undecryptable attachment instead of embedding it", () => {
    const m = model();
    m.channels[0].messages[0].attachments = [{ url: "https://blossom/enc", failed: true }];
    expect(exportHtml(m)).toContain("could not be decrypted");
  });

  it("shows an empty-channel placeholder", () => {
    expect(exportHtml(model())).toContain("No messages in this channel.");
  });
});

describe("exportHtml (untrusted URLs)", () => {
  it("does not let a kind-0 picture escape the <style> element", () => {
    const html = exportHtml(
      model({
        profiles: {
          aa: { pubkey: "aa", name: "Mallory", picture: "x</style><script>alert(1)</script><style>" },
        },
      }),
    );
    expect(html).not.toContain("</style><script>");
    expect(html).not.toContain("<script>alert(1)");
    // Refused outright, so the author renders as a monogram rather than as an
    // element carrying a class with no rule behind it.
    expect(html).toContain("avatar-fallback");
  });

  it("percent-encodes a picture URL instead of trusting a quote strip", () => {
    const html = exportHtml(
      model({ profiles: { aa: { pubkey: "aa", name: "A", picture: "https://x.example/a<b" } } }),
    );
    expect(html).not.toMatch(/url\("[^"]*</);
    expect(html).toContain("%3C");
  });

  it("still embeds an ordinary data: avatar", () => {
    expect(exportHtml(model())).toContain('.av-aa{background-image:url("data:image/png;base64,AAAA")}');
  });

  it("refuses a profile key that would break out of the stylesheet", () => {
    const key = "aa</style><script>alert(1)</script>";
    const html = exportHtml(
      model({ profiles: { [key]: { pubkey: key, name: "X", picture: "data:image/png;base64,AAAA" } } }),
    );
    expect(html).not.toContain("</style><script>");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("refuses a javascript: attachment URL as a link, but still shows it", () => {
    const m = model();
    m.channels[0].messages[0].attachments = [{ url: "javascript:alert(1)" }];
    const html = exportHtml(m);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("javascript:alert(1)");
  });

  it("refuses a javascript: source link on an undecryptable attachment", () => {
    const m = model();
    m.channels[0].messages[0].attachments = [{ url: "javascript:alert(1)", failed: true }];
    const html = exportHtml(m);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("could not be decrypted");
  });

  it("keeps a plain https attachment link", () => {
    const m = model();
    m.channels[0].messages[0].attachments = [{ url: "https://blossom.example/f.bin" }];
    expect(exportHtml(m)).toContain('href="https://blossom.example/f.bin"');
  });
});

describe("format registry + filename", () => {
  it("exposes only html", () => {
    expect(Object.keys(EXPORT_FORMATS)).toEqual(["html"]);
    expect(EXPORT_FORMATS.html.mime).toBe("text/html");
    const m = model();
    expect(EXPORT_FORMATS.html.write(m)).toBe(exportHtml(m));
  });

  it("builds a filesystem-safe name", () => {
    const name = exportFileName(model({ communityName: "My/Cool: Room" }), "html");
    expect(name).not.toMatch(/[/:]/);
    expect(name.endsWith(".html")).toBe(true);
    expect(name).toContain("2026-01-02");
  });
});
