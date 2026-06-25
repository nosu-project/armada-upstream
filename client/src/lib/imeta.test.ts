import { describe, expect, it } from "vitest";

import { parseImetaMap } from "./imeta";

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
