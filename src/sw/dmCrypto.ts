/**
 * NIP-17 gift-wrap unwrap for the Web Push service worker.
 *
 * The push gateway is content-blind and the classic service worker can't
 * `import`, so this module is bundled to a standalone IIFE
 * (`vite.config.sw-crypto.ts` → `dist/sw-crypto.js`) that `sw.js` loads with
 * `importScripts`. It exposes exactly one operation — unwrap an inlined gift
 * wrap to its sender + message preview — so the worker can make the
 * request-vs-known decision (and optionally show content for people you know)
 * WITHOUT a relay round-trip, which is the only way that work fits inside a
 * mobile push handler's execution window.
 *
 * It lives under `src/` (not hand-written into the SW) so tsc + eslint + vitest
 * cover it as ordinary source: the same reason `electronMain.ts` is bundled
 * rather than copied. The named `unwrapDm` export is what the unit test drives;
 * the global assignment at the bottom is what the worker consumes.
 */

import { getConversationKey, decrypt as nip44Decrypt } from "nostr-tools/nip44";
import { hexToBytes } from "@noble/hashes/utils.js";

import { openSealedConfig } from "@/lib/swSecretVault";

interface WrapEvent {
  pubkey: string;
  content: string;
  tags?: unknown;
}

/** The minimum a Web Push DM notification needs from an opened wrap. */
export interface OpenedDmNotification {
  /** The real sender — the seal's signer, hex. */
  sender: string;
  /** Inner rumor kind: 14 chat, 15 file; the caller ignores anything else. */
  kind: number;
  /** Plaintext message content (chat), or "" for a file. */
  content: string;
}

/** Whether any NIP-40 `expiration` tag has already passed. */
function expiredByTags(tags: unknown, now: number): boolean {
  if (!Array.isArray(tags)) return false;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === "expiration") {
      const at = Number(tag[1]);
      if (Number.isFinite(at) && at <= now) return true;
    }
  }
  return false;
}

/**
 * Unwrap a kind-1059 gift wrap addressed to the user, returning the sender and
 * message preview — or null for anything this key can't open, that's malformed,
 * that has already expired (NIP-40), or that is the user's own sent copy.
 *
 * Mirrors `openDmWrap`'s structural checks: the inner envelope must be a kind-13
 * seal and the rumor's author must equal the seal's signer (NIP-59 anti-spoof).
 * No Schnorr verify is needed for a notification decision — NIP-44's AEAD means
 * a successful seal decrypt already authenticates the seal author against us.
 */
export function unwrapDm(
  wrap: WrapEvent,
  skHex: string,
  selfPubkey: string,
): OpenedDmNotification | null {
  try {
    if (!wrap || typeof wrap.pubkey !== "string" || typeof wrap.content !== "string") return null;
    const now = Math.floor(Date.now() / 1000);
    if (expiredByTags(wrap.tags, now)) return null;

    const sk = hexToBytes(skHex);
    const seal = JSON.parse(
      nip44Decrypt(wrap.content, getConversationKey(sk, wrap.pubkey)),
    ) as { kind?: number; pubkey?: string; content?: string; tags?: unknown };
    if (seal.kind !== 13 || typeof seal.pubkey !== "string" || seal.pubkey.length !== 64) return null;
    if (typeof seal.content !== "string") return null;
    if (expiredByTags(seal.tags, now)) return null;
    if (seal.pubkey === selfPubkey) return null; // our own sent copy

    const rumor = JSON.parse(
      nip44Decrypt(seal.content, getConversationKey(sk, seal.pubkey)),
    ) as { pubkey?: string; kind?: unknown; content?: unknown; tags?: unknown };
    if (rumor.pubkey !== seal.pubkey) return null; // NIP-59 anti-spoof
    if (typeof rumor.kind !== "number" || typeof rumor.content !== "string") return null;
    if (expiredByTags(rumor.tags, now)) return null;

    return { sender: seal.pubkey, kind: rumor.kind, content: rumor.content };
  } catch {
    // Crypto/JSON failure → not a readable DM for us. Silent.
    return null;
  }
}

// Expose to the classic service worker (which loads this bundle via
// importScripts and can't consume ES exports). Assigned as a top-level side
// effect so rollup keeps it in the IIFE build even though nothing imports it
// there; the named export above is what vitest drives.
(
  globalThis as unknown as {
    ArmadaDmCrypto?: { unwrapDm: typeof unwrapDm; openConfig: typeof openSealedConfig };
  }
).ArmadaDmCrypto = {
  unwrapDm,
  // The DM gating config is AES-GCM sealed at rest under a non-extractable key
  // (swSecretVault); the worker opens it here per push before decrypting.
  openConfig: openSealedConfig,
};
