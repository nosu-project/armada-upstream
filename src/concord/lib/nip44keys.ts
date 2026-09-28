/**
 * NIP-44 v2 per-message key disclosure — the primitive Pins are built on
 * (CORD-04 §7). Per-message keys are `hkdf-expand(conversation_key, nonce, 76)`
 * = `chacha_key[32] || chacha_nonce[12] || hmac_key[32]`, one-way, so disclosing
 * them exposes exactly one message.
 *
 * nostr-tools keeps `getMessageKeys` and the decoder internal, so they're
 * reproduced here byte-for-byte. Wire format: divergence breaks pin verification.
 */

import { chacha20 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { expand as hkdfExpand } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

/** The disclosed material: exactly one message's keys. */
export interface MessageKeys {
  chachaKey: Uint8Array;
  chachaNonce: Uint8Array;
  hmacKey: Uint8Array;
}

/** Serialized disclosure length: 32 + 12 + 32. */
export const MESSAGE_KEYS_BYTES = 76;

/** The per-message expansion; needs the conversation key (i.e. a member at that epoch). */
export function getMessageKeys(conversationKey: Uint8Array, nonce: Uint8Array): MessageKeys {
  const keys = hkdfExpand(sha256, conversationKey, nonce, MESSAGE_KEYS_BYTES);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

const HEX = /^[0-9a-f]+$/;

/** Serialize a disclosure as the wire's 76-byte lowercase hex. */
export function encodeMessageKeys(keys: MessageKeys): string {
  const packed = concatBytes(keys.chachaKey, keys.chachaNonce, keys.hmacKey);
  let out = "";
  for (const b of packed) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Parse a 76-byte lowercase-hex disclosure; undefined if malformed. */
export function decodeMessageKeys(hex: string): MessageKeys | undefined {
  if (typeof hex !== "string" || hex.length !== MESSAGE_KEYS_BYTES * 2 || !HEX.test(hex)) return undefined;
  const bytes = new Uint8Array(MESSAGE_KEYS_BYTES);
  for (let i = 0; i < MESSAGE_KEYS_BYTES; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return {
    chachaKey: bytes.subarray(0, 32),
    chachaNonce: bytes.subarray(32, 44),
    hmacKey: bytes.subarray(44, 76),
  };
}

interface Payload {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  mac: Uint8Array;
}

/** Decode a NIP-44 v2 payload into its public parts; undefined if malformed. */
export function decodePayload(payload: string): Payload | undefined {
  if (typeof payload !== "string" || payload.length < 132 || payload[0] === "#") return undefined;
  let data: Uint8Array;
  try {
    data = base64.decode(payload);
  } catch {
    return undefined;
  }
  if (data.length < 99 || data[0] !== 2) return undefined;
  return { nonce: data.subarray(1, 33), ciphertext: data.subarray(33, -32), mac: data.subarray(-32) };
}

/** Unpad a decrypted NIP-44 plaintext; undefined if the padding is invalid. */
function unpad(padded: Uint8Array): string | undefined {
  if (padded.length < 2) return undefined;
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const firstTwo = dv.getUint16(0);
  let unpaddedLen: number;
  let prefixLen: number;
  if (firstTwo === 0) {
    if (padded.length < 6) return undefined;
    unpaddedLen = dv.getUint32(2);
    if (unpaddedLen < 65536) return undefined;
    prefixLen = 6;
  } else {
    unpaddedLen = firstTwo;
    prefixLen = 2;
  }
  const unpadded = padded.subarray(prefixLen, prefixLen + unpaddedLen);
  if (unpaddedLen < 1 || unpadded.length !== unpaddedLen) return undefined;
  if (padded.length !== prefixLen + calcPaddedLen(unpaddedLen)) return undefined;
  return new TextDecoder("utf-8").decode(unpadded);
}

function calcPaddedLen(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1) return -1;
  if (len <= 32) return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

/**
 * Open a NIP-44 v2 payload with DISCLOSED keys (a pin's proof). Returns
 * undefined on any failure, never throws. Nonce and ciphertext ride in the
 * payload, so a member with no channel history can verify.
 */
export function decryptWithDisclosedKeys(payload: string, keys: MessageKeys): string | undefined {
  const decoded = decodePayload(payload);
  if (!decoded) return undefined;
  const expectedMac = hmac(sha256, keys.hmacKey, concatBytes(decoded.nonce, decoded.ciphertext));
  if (!equalBytes(expectedMac, decoded.mac)) return undefined;
  let padded: Uint8Array;
  try {
    padded = chacha20(keys.chachaKey, keys.chachaNonce, decoded.ciphertext);
  } catch {
    return undefined;
  }
  return unpad(padded);
}

/** Produce the disclosure for one payload; needs the conversation key. */
export function discloseKeysFor(payload: string, conversationKey: Uint8Array): MessageKeys | undefined {
  const decoded = decodePayload(payload);
  if (!decoded) return undefined;
  return getMessageKeys(conversationKey, decoded.nonce);
}
