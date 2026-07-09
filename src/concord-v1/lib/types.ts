/**
 * Concord core types — ported from Vector's `community/mod.rs`.
 *
 * Ids are raw 32-byte opaque random values (NOT timestamp snowflakes, which
 * would leak creation time), carried as `Uint8Array` in memory and lowercase hex
 * on the wire. Keys (channel + server-root) are raw 32-byte NIP-44 conversation
 * keys used directly by `cipher`.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** 32 cryptographically-random bytes. */
export function random32(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** The all-zero hex scope id for server-root-scoped epoch keys. */
export const SERVER_ROOT_SCOPE_HEX = "0".repeat(64);

/** Protocol cap on a community's relay set. */
export const MAX_COMMUNITY_RELAYS = 5;

/**
 * Dedupe (order-preserving) + truncate a relay set to {@link MAX_COMMUNITY_RELAYS}.
 * Dedup first so the cap means "up to 5 DISTINCT relays".
 */
export function capRelays(relays: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of relays) {
    if (out.length >= MAX_COMMUNITY_RELAYS) break;
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

/** Lowercase hex of a 32-byte id/key. */
export function toHex(b: Uint8Array): string {
  return bytesToHex(b);
}

/** Parse a 64-char hex string to 32 bytes, throwing on malformed input. */
export function hex32(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`invalid or wrong-length 64-char hex (${hex.length} chars)`);
  }
  return hexToBytes(hex);
}

/** A channel inside a community: its own independent key, current epoch, and name. */
export interface Channel {
  /** Channel id (32 bytes). */
  id: Uint8Array;
  /** Channel key (32 bytes) — independent random material, NOT derived from the community. */
  key: Uint8Array;
  epoch: bigint;
  name: string;
  /** Every epoch key the member retains for this channel (post-rekey catch-up). */
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>;
}

/**
 * An encrypted blob reference (community logo / banner), ported from Vector's
 * `CommunityImage`. The blob lives on a Blossom-style host as ciphertext; the
 * per-image symmetric key rides inside the ServerRoot-sealed metadata, so a
 * relay/host scraper without membership sees only an opaque blob.
 */
export interface CommunityImage {
  /** URL of the encrypted blob. */
  url: string;
  /** Hex AES-GCM key for the blob. */
  key: string;
  /** Hex AES-GCM nonce/iv. */
  nonce: string;
  /** Hex SHA-256 of the plaintext (integrity check after decrypt). */
  hash: string;
  /** File extension / mime hint. */
  ext: string;
}

/** A Concord community (Discord's "server"). */
export interface Community {
  id: Uint8Array;
  /** @everyone base key, at `serverRootEpoch`. */
  serverRootKey: Uint8Array;
  serverRootEpoch: bigint;
  name: string;
  description?: string;
  /** Logo (encrypted blob ref). */
  icon?: CommunityImage;
  /** Banner (encrypted blob ref). */
  banner?: CommunityImage;
  relays: string[];
  channels: Channel[];
  /** Owner attestation (signed event JSON) binding this community's id to the owner. */
  ownerAttestation?: string;
}

/** Mint a brand-new community with one default channel. Keys are independently random. */
export function createCommunity(
  name: string,
  defaultChannelName: string,
  relays: string[],
): Community {
  return {
    id: random32(),
    serverRootKey: random32(),
    serverRootEpoch: 0n,
    name,
    relays: capRelays(relays),
    channels: [
      {
        id: random32(),
        key: random32(),
        epoch: 0n,
        name: defaultChannelName,
        epochKeys: [],
      },
    ],
    ownerAttestation: undefined,
  };
}
