import { describe, expect, it } from "vitest";

import { forwardableTags, forwardedAttachment, stripUrlsFromText } from "./forwardMessage";

const URL_A = "https://blossom.example/abc123";
const URL_B = "https://blossom.example/def456.jpg";

describe("forwardableTags", () => {
  it("drops everything that names the source", () => {
    const tags = forwardableTags({
      kind: 14,
      content: "hello",
      tags: [
        ["p", "peerpubkey"],
        ["e", "parentid"],
        ["q", "quotedid", "wss://relay.example", "authorpubkey"],
        ["h", "groupid"],
        ["a", "39000:pubkey:id"],
        ["expiration", "1900000000"],
        ["edited", "1"],
        ["bot", "botpubkey"],
        ["k", "14"],
      ],
    });
    expect(tags).toEqual([]);
  });

  it("carries an imeta verbatim, including its decryption params", () => {
    const imeta = [
      "imeta",
      `url ${URL_A}`,
      "m image/jpeg",
      "dim 800x600",
      "blurhash LKO2",
      "encryption-algorithm aes-gcm",
      `decryption-key ${"a".repeat(64)}`,
      "decryption-nonce 0123456789abcdef",
      "ox deadbeef",
    ];
    const tags = forwardableTags({
      kind: 14,
      content: `look at this ${URL_A}`,
      tags: [["p", "peer"], imeta],
    });
    expect(tags).toEqual([imeta]);
    // Verbatim, not re-encoded: a copy, but field-for-field identical.
    expect(tags[0]).not.toBe(imeta);
  });

  it("drops an imeta whose URL the edited draft no longer contains", () => {
    const event = {
      kind: 14,
      content: `a ${URL_A} b ${URL_B}`,
      tags: [
        ["imeta", `url ${URL_A}`, "m image/png"],
        ["imeta", `url ${URL_B}`, "m image/jpeg"],
      ],
    };
    const tags = forwardableTags(event, `only kept ${URL_B}`);
    expect(tags).toEqual([["imeta", `url ${URL_B}`, "m image/jpeg"]]);
  });

  it("keeps the first tag when a URL or shortcode repeats", () => {
    const tags = forwardableTags({
      kind: 14,
      content: `${URL_A} :cat:`,
      tags: [
        ["imeta", `url ${URL_A}`, "m image/png"],
        ["imeta", `url ${URL_A}`, "m image/gif"],
        ["emoji", "cat", "https://e.example/cat.png"],
        ["emoji", "cat", "https://e.example/other.png"],
      ],
    });
    expect(tags).toEqual([
      ["imeta", `url ${URL_A}`, "m image/png"],
      ["emoji", "cat", "https://e.example/cat.png"],
    ]);
  });

  it("carries only the emoji whose shortcode survives in the text", () => {
    const tags = forwardableTags(
      {
        kind: 14,
        content: "hi :cat: :dog:",
        tags: [
          ["emoji", "cat", "https://e.example/cat.png"],
          ["emoji", "dog", "https://e.example/dog.png"],
        ],
      },
      "hi :dog:",
    );
    expect(tags).toEqual([["emoji", "dog", "https://e.example/dog.png"]]);
  });

  it("ignores a malformed emoji tag", () => {
    const tags = forwardableTags({
      kind: 14,
      content: "hi :cat:",
      tags: [["emoji", "cat"]],
    });
    expect(tags).toEqual([]);
  });

  it("ignores an imeta with no url field", () => {
    const tags = forwardableTags({
      kind: 14,
      content: "hi",
      tags: [["imeta", "m image/png"], ["imeta", "malformed"]],
    });
    expect(tags).toEqual([]);
  });

  it("re-expresses a kind-15 file message's top-level tags as an imeta", () => {
    const key = "b".repeat(64);
    const tags = forwardableTags({
      kind: 15,
      content: URL_A,
      tags: [
        ["file-type", "image/jpeg"],
        ["encryption-algorithm", "aes-gcm"],
        ["decryption-key", key],
        ["decryption-nonce", "0123456789abcdef"],
        ["x", "hash1"],
        ["ox", "hash2"],
        ["size", "1024"],
        ["dim", "800x600"],
        ["blurhash", "LKO2"],
        ["thumb", "https://blossom.example/thumb"],
        ["p", "peer"],
      ],
    });
    expect(tags).toEqual([
      [
        "imeta",
        `url ${URL_A}`,
        "m image/jpeg",
        "x hash1",
        "ox hash2",
        "size 1024",
        "dim 800x600",
        "blurhash LKO2",
        "thumb https://blossom.example/thumb",
        "encryption-algorithm aes-gcm",
        `decryption-key ${key}`,
        "decryption-nonce 0123456789abcdef",
      ],
    ]);
  });

  it("does not synthesize a file imeta when the URL was edited out", () => {
    const tags = forwardableTags(
      { kind: 15, content: URL_A, tags: [["file-type", "image/jpeg"]] },
      "just some words",
    );
    expect(tags).toEqual([]);
  });

  it("ignores a kind-15 whose content is not an http(s) URL", () => {
    const tags = forwardableTags({
      kind: 15,
      content: "not-a-url",
      tags: [["file-type", "image/jpeg"]],
    });
    expect(tags).toEqual([]);
  });

  it("prefers an existing imeta over synthesizing one for a kind-15", () => {
    const tags = forwardableTags({
      kind: 15,
      content: URL_A,
      tags: [["imeta", `url ${URL_A}`, "m image/png"], ["file-type", "image/jpeg"]],
    });
    expect(tags).toEqual([["imeta", `url ${URL_A}`, "m image/png"]]);
  });
});

describe("forwardedAttachment", () => {
  it("splits an imeta into NIP-94 pairs, keeping the url pair", () => {
    expect(
      forwardedAttachment(["imeta", `url ${URL_B}`, "m image/jpeg", "dim 800x600", "ox hash"]),
    ).toEqual({
      url: URL_B,
      tags: [["url", URL_B], ["m", "image/jpeg"], ["dim", "800x600"], ["ox", "hash"]],
      encryption: undefined,
    });
  });

  it("lifts the encryption params (and ox) out of the pairs", () => {
    const key = "c".repeat(64);
    expect(
      forwardedAttachment([
        "imeta",
        `url ${URL_A}`,
        "m image/jpeg",
        "encryption-algorithm aes-gcm",
        `decryption-key ${key}`,
        "decryption-nonce 0123456789abcdef",
        "ox hash",
      ]),
    ).toEqual({
      url: URL_A,
      // No encryption/decryption/ox field survives here — the composer
      // re-appends them from `encryption`, so keeping both would emit each twice.
      tags: [["url", URL_A], ["m", "image/jpeg"]],
      encryption: {
        algorithm: "aes-gcm",
        key,
        nonce: "0123456789abcdef",
        ox: "hash",
      },
    });
  });

  it("leaves ox undefined when the sender omitted it", () => {
    const key = "d".repeat(64);
    const att = forwardedAttachment([
      "imeta",
      `url ${URL_A}`,
      "encryption-algorithm aes-gcm",
      `decryption-key ${key}`,
      "decryption-nonce abcd",
    ]);
    expect(att?.encryption?.ox).toBeUndefined();
  });

  it("keeps ox as an ordinary pair on a plaintext attachment", () => {
    const att = forwardedAttachment(["imeta", `url ${URL_A}`, "ox hash"]);
    expect(att?.tags).toEqual([["url", URL_A], ["ox", "hash"]]);
    expect(att?.encryption).toBeUndefined();
  });

  it("returns null for an imeta naming no url", () => {
    expect(forwardedAttachment(["imeta", "m image/png"])).toBeNull();
  });
});

describe("stripUrlsFromText", () => {
  it("removes the URL and tidies the gap it leaves", () => {
    expect(stripUrlsFromText(`look at this ${URL_A} isn't it nice`, [URL_A])).toBe(
      "look at this isn't it nice",
    );
  });

  it("empties a message that was only a URL", () => {
    expect(stripUrlsFromText(URL_A, [URL_A])).toBe("");
  });

  it("collapses the blank line a lone URL leaves behind", () => {
    expect(stripUrlsFromText(`caption\n${URL_A}\nmore`, [URL_A])).toBe("caption\nmore");
  });

  it("removes every occurrence, and leaves other text alone", () => {
    expect(stripUrlsFromText(`${URL_A} and ${URL_A} and ${URL_B}`, [URL_A])).toBe(
      `and and ${URL_B}`,
    );
  });

  it("is a no-op when no URL matches", () => {
    expect(stripUrlsFromText("just words", [URL_A])).toBe("just words");
  });
});

describe("forwardableTags kind-15 imeta precedence", () => {
  it("prefers an existing imeta over synthesizing one", () => {
    const tags = forwardableTags({
      kind: 15,
      content: URL_A,
      tags: [["imeta", `url ${URL_A}`, "m image/png"], ["file-type", "image/jpeg"]],
    });
    expect(tags).toEqual([["imeta", `url ${URL_A}`, "m image/png"]]);
  });
});
