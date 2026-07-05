/**
 * Raw-key NIP-44 v2 sealing — the single symmetric-encryption primitive of the
 * Concord protocol. Ported from Vector's `community/cipher.rs`.
 *
 * The channel key (message plane) and the server-root key (metadata plane) are
 * both raw 32-byte NIP-44 conversation keys; ciphertext is base64'd for carriage
 * in an event's string `content` field. nostr-tools' `nip44.encrypt/decrypt`
 * take the raw 32-byte conversation key directly and produce base64 — identical
 * wire output to Vector's `ConversationKey::new(key)` path.
 */

import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";

/** Encrypt `plaintext` under a raw 32-byte key, returning base64 for event content. */
export function seal(key: Uint8Array, plaintext: string): string {
  if (key.length !== 32) throw new Error(`cipher key must be 32 bytes, got ${key.length}`);
  return nip44Encrypt(plaintext, key);
}

/**
 * Inverse of {@link seal}: NIP-44-decrypt under the raw key. A wrong key or
 * tampered payload fails the MAC and throws.
 */
export function open(key: Uint8Array, contentB64: string): string {
  if (key.length !== 32) throw new Error(`cipher key must be 32 bytes, got ${key.length}`);
  return nip44Decrypt(contentB64, key);
}
