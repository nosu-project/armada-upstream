import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** The fixed length of a base36-encoded 32-byte value (256 bits). */
const BASE36_LENGTH = 50;

/** Encode a hex string as a zero-padded base36 string (50 chars for 32 bytes). */
function hexToBase36(hex: string): string {
  let n = 0n;
  for (let i = 0; i < hex.length; i++) {
    n = n * 16n + BigInt(parseInt(hex[i], 16));
  }
  return n.toString(36).padStart(BASE36_LENGTH, "0");
}

/** localStorage key for the device-local sandbox seed. */
const SEED_KEY = "armada:sandbox-seed";

/**
 * Get or create a device-local random seed persisted in localStorage. This is
 * a general-purpose secret used to derive private, unpredictable identifiers
 * (the per-app sandbox subdomain) so that a third party cannot guess another
 * app's subdomain and reach its origin-keyed storage.
 */
function getSeed(): string {
  try {
    const stored = localStorage.getItem(SEED_KEY);
    if (stored) return stored;
    const seed = crypto.randomUUID();
    localStorage.setItem(SEED_KEY, seed);
    return seed;
  } catch {
    // Private mode / no storage: fall back to an ephemeral per-session seed.
    return "armada-ephemeral-sandbox-seed";
  }
}

/**
 * Derive a stable, private subdomain label for a sandbox frame.
 *
 * Uses HMAC-SHA256 with the device-local seed as the key and
 * `prefix|identifier` as the message. Because the seed is secret to this
 * device, a third party cannot predict or collide with another app's
 * subdomain, preventing cross-app localStorage/IndexedDB access on the sandbox
 * domain. The `prefix` is a domain separator (e.g. "webxdc"); the result is a
 * 50-char base36 string that fits the 63-char subdomain-label limit.
 */
export function deriveIframeSubdomain(prefix: string, identifier: string): string {
  const enc = new TextEncoder();
  const mac = hmac(sha256, enc.encode(getSeed()), enc.encode(`${prefix}|${identifier}`));
  return hexToBase36(bytesToHex(mac));
}
