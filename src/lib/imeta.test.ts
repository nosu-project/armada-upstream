import { describe, expect, it } from "vitest";

import { companionEncryption, isSupportedEncryption, parseFileMessageTags, parseImetaMap } from "./imeta";

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
      ox: "c".repeat(64),
    });
    expect(isSupportedEncryption(entry!.encryption)).toBe(true);
  });

  it("omits encryption for plaintext imeta", () => {
    const tags = [["imeta", "url https://x/y.png", "m image/png"]];
    expect(parseImetaMap(tags).get("https://x/y.png")?.encryption).toBeUndefined();
  });

  it("reports malformed crypto params as unsupported, NOT as plaintext", () => {
    // The distinction is the whole point: `undefined` means "not encrypted",
    // and a caller acts on that by rendering the URL — which for any of these
    // is ciphertext painted into an <img>.
    const base = "url https://x/y.png";
    const cases = [
      ["imeta", base, "encryption-algorithm aes-gcm", "decryption-key short", `decryption-nonce ${"b".repeat(32)}`],
      ["imeta", base, "encryption-algorithm aes-gcm", `decryption-key ${"g".repeat(64)}`, `decryption-nonce ${"b".repeat(32)}`],
      ["imeta", base, "encryption-algorithm xchacha20", `decryption-key ${"a".repeat(64)}`, `decryption-nonce ${"b".repeat(32)}`],
      ["imeta", base, "encryption-algorithm aes-gcm", `decryption-key ${"a".repeat(64)}`], // no nonce
    ];
    for (const tag of cases) {
      const enc = parseImetaMap([tag]).get("https://x/y.png")?.encryption;
      expect(enc).toBeDefined();
      expect(isSupportedEncryption(enc)).toBe(false);
    }
  });

  it("accepts base64 key material as well as hex", () => {
    // Neither NIP-17 nor NIP-94 pins an encoding for the decryption params.
    const keyBytes = new Uint8Array(32).fill(0xab);
    const nonceBytes = new Uint8Array(16).fill(0xcd);
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
    const tags = [
      [
        "imeta",
        "url https://x/y.png",
        "encryption-algorithm aes-gcm",
        `decryption-key ${b64(keyBytes)}`,
        `decryption-nonce ${b64(nonceBytes)}`,
      ],
    ];
    const enc = parseImetaMap(tags).get("https://x/y.png")?.encryption;
    // Normalized to hex at parse time, so everything downstream stays hex.
    expect(enc?.key).toBe("ab".repeat(32));
    expect(enc?.nonce).toBe("cd".repeat(16));
    expect(isSupportedEncryption(enc)).toBe(true);
  });

  it("collects repeated `fallback` fields instead of collapsing them", () => {
    const tags = [
      [
        "imeta",
        "url https://a/blob",
        "fallback https://b/blob",
        "fallback https://c/blob",
      ],
    ];
    expect(parseImetaMap(tags).get("https://a/blob")?.fallbacks).toEqual([
      "https://b/blob",
      "https://c/blob",
    ]);
  });

  it("drops `ox` for a companion blob", () => {
    // A thumb shares the key and nonce but is its own blob, so the file's
    // plaintext hash does not describe it.
    const enc = { algorithm: "aes-gcm", key: "a".repeat(64), nonce: "b".repeat(32), ox: "c".repeat(64) };
    expect(companionEncryption(enc)).toEqual({
      algorithm: "aes-gcm",
      key: "a".repeat(64),
      nonce: "b".repeat(32),
    });
    expect(companionEncryption(enc)?.ox).toBeUndefined();
    expect(companionEncryption(undefined)).toBeUndefined();
  });

  it("prefers `thumb` then `image` for the thumbnail", () => {
    const withBoth = [["imeta", "url https://x/y.mp4", "thumb https://t/1", "image https://t/2"]];
    expect(parseImetaMap(withBoth).get("https://x/y.mp4")?.thumbnail).toBe("https://t/1");

    const imageOnly = [["imeta", "url https://x/y.mp4", "image https://t/2"]];
    expect(parseImetaMap(imageOnly).get("https://x/y.mp4")?.thumbnail).toBe("https://t/2");
  });

  it("covers the thumbnail with the file's own decryption params", () => {
    // NIP-17: a `thumb` is "encrypted with the same key, nonce" as its file,
    // so one params pair decrypts both blobs.
    const tags = [
      [
        "imeta",
        "url https://x/y.mp4",
        "m video/mp4",
        "thumb https://x/poster.jpg",
        "encryption-algorithm aes-gcm",
        `decryption-key ${"a".repeat(64)}`,
        `decryption-nonce ${"b".repeat(32)}`,
      ],
    ];
    const entry = parseImetaMap(tags).get("https://x/y.mp4");
    expect(entry?.thumbnail).toBe("https://x/poster.jpg");
    expect(entry?.encryption).toEqual({
      algorithm: "aes-gcm",
      key: "a".repeat(64),
      nonce: "b".repeat(32),
    });
  });

  it("does not expose the poster as an attachment of its own", () => {
    // ChatContent renders an embed for every imeta URL that isn't already in
    // the body. The poster must stay a field on the video's entry, or a video
    // message would render its own thumbnail as a second, separate image.
    const tags = [
      [
        "imeta",
        "url https://x/y.mp4",
        "m video/mp4",
        "image https://x/poster.jpg",
        "thumb https://x/poster.jpg",
      ],
    ];
    const map = parseImetaMap(tags);
    expect([...map.keys()]).toEqual(["https://x/y.mp4"]);
    expect(map.has("https://x/poster.jpg")).toBe(false);
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
      // `ox` hashes the PLAINTEXT, so it is verifiable only after decrypting —
      // which is what makes a swapped blob fail closed. `x` hashes the
      // ciphertext and is not what we check.
      ox: "92b9ff334f9ab499a529f7a8c63b46400dd6971104079195b036ac53e09c0665",
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

describe("the webxdc realtime session field", () => {
  const imeta = (...fields: string[]): string[][] => [["imeta", "url https://x.example/a.xdc", ...fields]];
  const TOPIC = "OE4PCJOZJEGHXO3XRI3VFSHXVZDQ562TQIJITJUZTU3G6FQP4GXA";
  const read = (tags: string[][]) => parseImetaMap(tags).get("https://x.example/a.xdc")?.webxdc;

  it("reads Vector's `webxdc-topic`, which is what makes a game shared across clients", () => {
    expect(read(imeta(`webxdc-topic ${TOPIC}`))).toBe(TOPIC);
  });

  it("still reads the legacy `webxdc` field, so old Armada sessions keep working", () => {
    const uuid = "8f1c0c2e-4b3a-4a6d-9c1f-2f2b1a0d5e77";
    expect(read(imeta(`webxdc ${uuid}`))).toBe(uuid);
  });

  it("prefers the interop field when a sender writes both", () => {
    // Armada writes both: the same value in each, so this only decides which
    // wins if they ever disagree. The field Vector validates should.
    expect(read(imeta(`webxdc legacy-value`, `webxdc-topic ${TOPIC}`))).toBe(TOPIC);
    expect(read(imeta(`webxdc-topic ${TOPIC}`, `webxdc legacy-value`))).toBe(TOPIC);
  });

  it("leaves a plain attachment without a session", () => {
    expect(read(imeta("m image/png"))).toBeUndefined();
  });
});
