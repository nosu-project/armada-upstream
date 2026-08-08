/**
 * The vendored NIP-44 v2 key disclosure, checked against nostr-tools' own
 * implementation. If these diverge, pin proofs verify in one client and fail in
 * another — silently, since a failed entry is simply dropped.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { encrypt, decrypt, getConversationKey } from "nostr-tools/nip44";
import { describe, expect, it } from "vitest";

import {
  MESSAGE_KEYS_BYTES,
  decodeMessageKeys,
  decodePayload,
  decryptWithDisclosedKeys,
  discloseKeysFor,
  encodeMessageKeys,
} from "@/concord/lib/nip44keys";

function convKey() {
  const a = generateSecretKey();
  const b = generateSecretKey();
  return getConversationKey(a, getPublicKey(b));
}

describe("disclosed-key decryption", () => {
  it("opens what nostr-tools encrypted, without the conversation key", () => {
    const key = convKey();
    for (const plaintext of ["gm", "Hey chat!", "x".repeat(5000), "🔑 unicode ✅", JSON.stringify({ a: 1 })]) {
      const payload = encrypt(plaintext, key);
      const disclosed = discloseKeysFor(payload, key)!;
      expect(decryptWithDisclosedKeys(payload, disclosed)).toBe(plaintext);
      // …and agrees with the library's own decrypt.
      expect(decrypt(payload, key)).toBe(plaintext);
    }
  });

  it("the disclosure is exactly 76 bytes and round-trips through hex", () => {
    const key = convKey();
    const payload = encrypt("gm", key);
    const disclosed = discloseKeysFor(payload, key)!;
    const hex = encodeMessageKeys(disclosed);
    expect(hex).toHaveLength(MESSAGE_KEYS_BYTES * 2);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(decryptWithDisclosedKeys(payload, decodeMessageKeys(hex)!)).toBe("gm");
  });

  it("discloses ONE message: a sibling's keys open nothing", () => {
    const key = convKey();
    const mine = encrypt("secret one", key);
    const other = encrypt("secret two", key);
    const disclosed = discloseKeysFor(mine, key)!;
    expect(decryptWithDisclosedKeys(mine, disclosed)).toBe("secret one");
    expect(decryptWithDisclosedKeys(other, disclosed), "sibling stays sealed").toBeUndefined();
  });

  it("refuses a tampered ciphertext, a tampered MAC, and foreign keys", () => {
    const key = convKey();
    const payload = encrypt("gm", key);
    const disclosed = discloseKeysFor(payload, key)!;

    // Flip one ciphertext byte, re-encode: the MAC no longer matches.
    const raw = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const tampered = new Uint8Array(raw);
    tampered[40] ^= 0xff;
    const tamperedPayload = btoa(String.fromCharCode(...tampered));
    expect(decryptWithDisclosedKeys(tamperedPayload, disclosed)).toBeUndefined();

    // Keys from an unrelated conversation.
    const foreign = discloseKeysFor(encrypt("gm", convKey()), convKey());
    expect(foreign).toBeDefined();
    expect(decryptWithDisclosedKeys(payload, foreign!)).toBeUndefined();
  });

  it("returns undefined rather than throwing on malformed input", () => {
    const key = convKey();
    const disclosed = discloseKeysFor(encrypt("gm", key), key)!;
    for (const bad of ["", "not-base64!!", "#unsupported-version", "AA", "x".repeat(200)]) {
      expect(() => decryptWithDisclosedKeys(bad, disclosed)).not.toThrow();
      expect(decryptWithDisclosedKeys(bad, disclosed)).toBeUndefined();
    }
    expect(decodePayload("")).toBeUndefined();
    expect(decodeMessageKeys("abc")).toBeUndefined();
    expect(decodeMessageKeys("A".repeat(152)), "uppercase hex refused").toBeUndefined();
  });
});
