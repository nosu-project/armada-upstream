import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const BASE36_LENGTH = 50;

function hexToBase36(hex: string): string {
  let n = 0n;
  for (let i = 0; i < hex.length; i++) {
    n = n * 16n + BigInt(parseInt(hex[i], 16));
  }
  return n.toString(36).padStart(BASE36_LENGTH, "0");
}

const SEED_KEY = "armada:sandbox-seed";

/**
 * Device-local secret seed, so third parties can't guess another app's sandbox
 * subdomain and reach its origin-keyed storage.
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
 * Private, stable sandbox subdomain label: HMAC-SHA256(seed, `prefix|identifier`)
 * as 50-char base36 (fits the 63-char label limit). `prefix` is a domain separator.
 */
export function deriveIframeSubdomain(prefix: string, identifier: string): string {
  const enc = new TextEncoder();
  const mac = hmac(sha256, enc.encode(getSeed()), enc.encode(`${prefix}|${identifier}`));
  return hexToBase36(bytesToHex(mac));
}
