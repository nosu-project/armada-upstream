import { describe, expect, it } from "vitest";

import { decryptBytes, encryptBytes, encryptFileWithParams } from "./encryptedMedia";

/**
 * Interop guarantees for client-encrypted Blossom attachments (Vector / 0xChat):
 * a 32-byte key + 16-byte (0xChat-compatible) nonce, ciphertext laid out as
 * `ciphertext || 16-byte GCM tag`, round-tripping via the imeta-carried params.
 *
 * These exercise the raw byte crypto directly (jsdom's Blob/File mangle binary
 * data, so File-level round-trips can't be asserted reliably here; the File
 * wrapper just reads `file.arrayBuffer()` and forwards to `encryptBytes`).
 */
describe("encryptedMedia crypto", () => {
  it("round-trips plaintext through encrypt → decrypt", async () => {
    const key = "a".repeat(64);
    const nonce = "b".repeat(32); // 16 bytes
    const plaintext = new TextEncoder().encode("the quick brown fox jumps over 13 lazy dogs");

    const ciphertext = await encryptBytes(plaintext, key, nonce);
    // ciphertext = plaintext + 16-byte GCM tag
    expect(ciphertext.length).toBe(plaintext.length + 16);

    const decrypted = await decryptBytes(ciphertext, key, nonce);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it("fails to decrypt with the wrong key (auth tag check)", async () => {
    const nonce = "b".repeat(32);
    const ciphertext = await encryptBytes(new Uint8Array([1, 2, 3]), "a".repeat(64), nonce);
    await expect(decryptBytes(ciphertext, "c".repeat(64), nonce)).rejects.toThrow();
  });

  it("uses a 16-byte nonce (0xChat / Vector compatible), not 12", async () => {
    // A 16-byte nonce must be accepted by AES-GCM here (WebCrypto allows any IV
    // length); this is what makes Vector-originated blobs decryptable.
    const key = "a".repeat(64);
    const nonce16 = "b".repeat(32);
    const data = new Uint8Array([9, 8, 7, 6, 5]);
    const ct = await encryptBytes(data, key, nonce16);
    expect(Array.from(await decryptBytes(ct, key, nonce16))).toEqual(Array.from(data));
  });
});

/**
 * NIP-17 specifies that a `thumb` (and any `fallback` source) is "encrypted
 * with the same key, nonce" as the file it accompanies, so the message's
 * single decryption-key/nonce pair decrypts every blob of the attachment.
 */
describe("encryptFileWithParams", () => {
  const key = "a".repeat(64);
  const nonce = "b".repeat(32);

  /** jsdom's File has no `arrayBuffer()`; supply just that. */
  function file(content: string, name: string, type?: string): File {
    const f = new File([content], name, type ? { type } : undefined);
    Object.defineProperty(f, "arrayBuffer", {
      value: async () => new TextEncoder().encode(content).buffer,
    });
    return f;
  }

  it("encrypts under the supplied key and nonce", async () => {
    const result = await encryptFileWithParams(file("video", "clip.mp4"), key, nonce);
    expect(result.key).toBe(key);
    expect(result.nonce).toBe(nonce);
  });

  it("gives a video and its thumbnail identical params", async () => {
    const video = await encryptFileWithParams(file("video", "clip.mp4"), key, nonce);
    const thumb = await encryptFileWithParams(file("poster", "clip.jpg"), video.key, video.nonce);

    expect(thumb.key).toBe(video.key);
    expect(thumb.nonce).toBe(video.nonce);
  });

  it("keeps the plaintext MIME on the ciphertext file", async () => {
    // Blossom servers commonly reject application/octet-stream.
    const thumb = await encryptFileWithParams(file("poster", "clip.jpg", "image/jpeg"), key, nonce);
    expect(thumb.file.type).toBe("image/jpeg");
  });
});
