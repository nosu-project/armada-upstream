import { describe, expect, it } from "vitest";

import { parseFileMessageTags, parseImetaMap } from "./imeta";

describe("parseImetaMap encryption fields", () => {
  it("parses Vector / 0xChat encrypted-attachment imeta", () => {
    const tags = [
      [
        "imeta",
        "url https://blossom.example/abc.jpg",
        "m image/jpeg",
        "encryption-algorithm aes-gcm",
        `decryption-key ${"a".repeat(64)}`,
        `decryption-nonce ${"b".repeat(32)}`,
        "ox " + "c".repeat(64),
        "dim 800x600",
        "name photo.jpg",
      ],
    ];
    const map = parseImetaMap(tags);
    const entry = map.get("https://blossom.example/abc.jpg");
    expect(entry).toBeDefined();
    expect(entry!.mime).toBe("image/jpeg");
    expect(entry!.dim).toBe("800x600");
    expect(entry!.name).toBe("photo.jpg");
    expect(entry!.encryption).toEqual({
      algorithm: "aes-gcm",
      key: "a".repeat(64),
      nonce: "b".repeat(32),
    });
  });

  it("omits encryption for plaintext imeta", () => {
    const tags = [["imeta", "url https://x/y.png", "m image/png"]];
    expect(parseImetaMap(tags).get("https://x/y.png")?.encryption).toBeUndefined();
  });

  it("rejects malformed crypto params (wrong key length, non-hex, non-aes-gcm)", () => {
    const base = "url https://x/y.png";
    const cases = [
      ["imeta", base, "encryption-algorithm aes-gcm", "decryption-key short", `decryption-nonce ${"b".repeat(32)}`],
      ["imeta", base, "encryption-algorithm aes-gcm", `decryption-key ${"g".repeat(64)}`, `decryption-nonce ${"b".repeat(32)}`],
      ["imeta", base, "encryption-algorithm xchacha20", `decryption-key ${"a".repeat(64)}`, `decryption-nonce ${"b".repeat(32)}`],
      ["imeta", base, "encryption-algorithm aes-gcm", `decryption-key ${"a".repeat(64)}`], // no nonce
    ];
    for (const tag of cases) {
      expect(parseImetaMap([tag]).get("https://x/y.png")?.encryption).toBeUndefined();
    }
  });

  it("normalizes key/nonce to lowercase hex", () => {
    const tags = [
      [
        "imeta",
        "url https://x/y.png",
        "encryption-algorithm AES-GCM",
        `decryption-key ${"A".repeat(64)}`,
        `decryption-nonce ${"B".repeat(32)}`,
      ],
    ];
    expect(parseImetaMap(tags).get("https://x/y.png")?.encryption).toEqual({
      algorithm: "aes-gcm",
      key: "a".repeat(64),
      nonce: "b".repeat(32),
    });
  });
});

describe("parseFileMessageTags (NIP-17 kind-15 top-level tags)", () => {
  // The exact shape Amethyst sends for an encrypted DM image.
  const url = "https://blossom.primal.net/04feb9edb5d4ab38cfebba1b2241e929935c0c34f3bde94e6315dc75d0b51605";
  const tags = [
    ["alt", "Encrypted file in chat"],
    ["p", "86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47", "wss://relay.ditto.pub/"],
    ["encryption-algorithm", "aes-gcm"],
    ["decryption-key", "2ba22dd1814e0587d73fbe9f544d0c08f58502ec1d078363380b362301507c7e"],
    ["decryption-nonce", "84d8e88286054d466167d1394b6a98cd"],
    ["x", "04feb9edb5d4ab38cfebba1b2241e929935c0c34f3bde94e6315dc75d0b51605"],
    ["size", "128814"],
    ["file-type", "image/jpeg"],
    ["ox", "92b9ff334f9ab499a529f7a8c63b46400dd6971104079195b036ac53e09c0665"],
    ["client", "Amethyst"],
  ];

  it("reads MIME from file-type and the AES-GCM decryption params from top-level tags", () => {
    const entry = parseFileMessageTags(url, tags);
    expect(entry).toBeDefined();
    expect(entry!.url).toBe(url);
    expect(entry!.mime).toBe("image/jpeg");
    expect(entry!.encryption).toEqual({
      algorithm: "aes-gcm",
      key: "2ba22dd1814e0587d73fbe9f544d0c08f58502ec1d078363380b362301507c7e",
      nonce: "84d8e88286054d466167d1394b6a98cd",
    });
  });

  it("yields a plaintext entry when no encryption params are present", () => {
    const entry = parseFileMessageTags(url, [["file-type", "image/png"]]);
    expect(entry?.mime).toBe("image/png");
    expect(entry?.encryption).toBeUndefined();
  });

  it("rejects a non-http(s) URL", () => {
    expect(parseFileMessageTags("javascript:alert(1)", tags)).toBeUndefined();
    expect(parseFileMessageTags("", tags)).toBeUndefined();
  });

  it("prefers `thumb` then `image` for the thumbnail", () => {
    expect(parseFileMessageTags(url, [["thumb", "https://t/1"], ["image", "https://t/2"]])?.thumbnail).toBe("https://t/1");
    expect(parseFileMessageTags(url, [["image", "https://t/2"]])?.thumbnail).toBe("https://t/2");
  });
});
