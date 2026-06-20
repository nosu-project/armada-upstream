/**
 * Concord key-derivation convention — FROZEN, ported from Vector's
 * `crates/vector-core/src/community/derive.rs`.
 *
 * Every HKDF use in the Concord protocol funnels through here. Changing any
 * byte of the construction shifts every pseudonym and sub-key, orphaning all
 * prior events. The layout is locked by the golden vectors in `derive.test.ts`
 * (produced by an independent RFC-5869 implementation in Vector); treat those
 * as the spec, not this code.
 *
 * Construction: `HKDF-SHA256(IKM, salt=∅, info, L=32)`, where
 *   `info = utf8(label) || 0x00 || id32 || epoch_be` —
 *     - `label`    : ASCII purpose string, no terminator
 *     - `0x00`     : single separator byte
 *     - `id32`     : raw 32-byte id (channel id, or scope id), never hex
 *     - `epoch_be` : the epoch as u64 big-endian (8 bytes); omitted where noted
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// ── Purpose labels ───────────────────────────────────────────────────────────
//
// These strings are part of the wire format — append new ones, never edit or
// reuse an existing one. The "vector-community/v1/…" prefix is kept verbatim so
// derivations match Vector byte-for-byte (the wire format is shared, not forked).

const LABEL_CHANNEL_PSEUDONYM = "vector-community/v1/channel-pseudonym";
const LABEL_RECIPIENT_PSEUDONYM = "vector-community/v1/recipient-pseudonym";
const LABEL_REKEY_PSEUDONYM = "vector-community/v1/rekey-pseudonym";
const LABEL_BASE_REKEY_PSEUDONYM = "vector-community/v1/base-rekey-pseudonym";
const LABEL_PUBLIC_INVITE_KEY = "vector-community/v1/public-invite-key";
const LABEL_PUBLIC_INVITE_LOCATOR = "vector-community/v1/public-invite-locator";
const LABEL_PUBLIC_INVITE_SIGNER = "vector-community/v1/public-invite-signer";
const LABEL_BANLIST_LOCATOR = "vector-community/v1/banlist-locator";
const LABEL_GRANT_LOCATOR = "vector-community/v1/grant-locator";
const LABEL_INVITE_LINKS_LOCATOR = "vector-community/v1/invite-links-locator";
const LABEL_DISSOLVED_LOCATOR = "vector-community/v1/dissolved-locator";
const LABEL_DISSOLVED_PSEUDONYM = "vector-community/v1/dissolved-pseudonym";
const LABEL_DISSOLVED_ENVELOPE = "vector-community/v1/dissolved-envelope-key";

// Concord voice (armada extension — NOT part of Vector's shared format, hence
// the distinct "armada-concord/v1/voice/…" prefix so a future Vector label can
// never collide). All three are keyed by the per-channel key + channel id +
// epoch, so every voice coordinate rolls automatically on a channel rekey:
//   - signer : the secp256k1 key the community self-signs voice grants with;
//              its x-only pubkey IS the LiveKit room name, so a blind broker
//              binds "room name == grant signer" with no community knowledge.
//   - e2ee   : the SFrame/insertable-streams media key fed to LiveKit's
//              ExternalE2EEKeyProvider, so the SFU forwards ciphertext it can't
//              decode (content-blind). Every member derives the same key.
const LABEL_VOICE_SIGNER = "armada-concord/v1/voice/signer";
const LABEL_VOICE_E2EE = "armada-concord/v1/voice/e2ee-key";

const ZERO_ID32 = new Uint8Array(32);
const ASCII = new TextEncoder();

// ── Core construction ────────────────────────────────────────────────────────

/**
 * Build the frozen `info` byte string. `epoch` is `undefined` for the no-epoch
 * derivations (the grant + invite-links locators and the public-invite
 * sub-keys). Epoch is serialized as u64 big-endian.
 */
function buildInfo(label: string, id32: Uint8Array, epoch?: bigint): Uint8Array {
  const labelBytes = ASCII.encode(label);
  const hasEpoch = epoch !== undefined;
  const out = new Uint8Array(labelBytes.length + 1 + 32 + (hasEpoch ? 8 : 0));
  let o = 0;
  out.set(labelBytes, o);
  o += labelBytes.length;
  out[o] = 0x00;
  o += 1;
  out.set(id32, o);
  o += 32;
  if (hasEpoch) {
    new DataView(out.buffer).setBigUint64(o, epoch, false); // big-endian
  }
  return out;
}

/**
 * HKDF-SHA256 expand to 32 bytes with an empty salt. RFC 5869 with no salt
 * uses HashLen zero bytes; noble's `hkdf` with a zero-length salt matches the
 * spec's "salt=∅" (and Vector's Rust `Hkdf::new(None, ..)`).
 */
function hkdf32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), info, 32);
}

/** Normalize an epoch arg to a bigint (accepts number or bigint). */
function toEpoch(epoch: number | bigint): bigint {
  return typeof epoch === "bigint" ? epoch : BigInt(epoch);
}

function assert32(name: string, b: Uint8Array): void {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
}

// ── Stable, rotation-invariant locators (community-id-keyed) ─────────────────

/** Opaque coordinate for the banlist entity (HKDF of the community id). */
export function banlistLocator(communityId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, ASCII.encode(LABEL_BANLIST_LOCATOR));
}

/** Opaque coordinate for the owner-dissolution tombstone (vsk=10). */
export function dissolvedLocator(communityId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, ASCII.encode(LABEL_DISSOLVED_LOCATOR));
}

/** Rotation-stable relay `#z` for the dissolution tombstone (hex). */
export function dissolvedPseudonym(communityId: Uint8Array): string {
  assert32("communityId", communityId);
  return bytesToHex(hkdf32(communityId, ASCII.encode(LABEL_DISSOLVED_PSEUDONYM)));
}

/** Rotation-stable envelope key for the dissolution tombstone. */
export function dissolvedEnvelopeKey(communityId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, ASCII.encode(LABEL_DISSOLVED_ENVELOPE));
}

/** Opaque coordinate for a creator's own invite-links entity (vsk=8). */
export function inviteLinksLocator(communityId: Uint8Array, creatorXonly: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("creatorXonly", creatorXonly);
  return hkdf32(communityId, buildInfo(LABEL_INVITE_LINKS_LOCATOR, creatorXonly));
}

/** Opaque coordinate for a member's Grant entity (vsk=3), bound to their x-only pubkey. */
export function grantLocator(communityId: Uint8Array, memberXonly: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("memberXonly", memberXonly);
  return hkdf32(communityId, buildInfo(LABEL_GRANT_LOCATOR, memberXonly));
}

// ── Rekey scope ──────────────────────────────────────────────────────────────

/** Scope of a per-recipient rekey blob: a specific channel, or the server root. */
export type RekeyScope =
  | { kind: "channel"; channelId: Uint8Array }
  | { kind: "server-root" };

/** The 32-byte scope id this rekey binds: the channel id, or the all-zero sentinel. */
export function rekeyScopeId32(scope: RekeyScope): Uint8Array {
  return scope.kind === "channel" ? scope.channelId : ZERO_ID32;
}

// ── Pseudonyms (rotating relay `#z` addresses) ───────────────────────────────

/**
 * Channel pseudonym: the value carried in the relay-filterable `z` tag. Every
 * member derives the same one from the shared channel key, so it both addresses
 * and (by epoch rotation) unlinks the channel's traffic. Returns raw 32 bytes.
 */
export function channelPseudonym(
  channelKey: Uint8Array,
  channelId: Uint8Array,
  epoch: number | bigint,
): Uint8Array {
  assert32("channelKey", channelKey);
  assert32("channelId", channelId);
  return hkdf32(channelKey, buildInfo(LABEL_CHANNEL_PSEUDONYM, channelId, toEpoch(epoch)));
}

/**
 * The relay-filterable address of a channel REKEY event for `(channel, epoch)`,
 * derived from the **server-root key** (not the channel key) — so any member
 * can compute it for any epoch without holding that epoch's channel key, which
 * is what makes epochs independently recoverable.
 */
export function rekeyPseudonym(
  serverRoot: Uint8Array,
  channelId: Uint8Array,
  epoch: number | bigint,
): Uint8Array {
  assert32("serverRoot", serverRoot);
  assert32("channelId", channelId);
  return hkdf32(serverRoot, buildInfo(LABEL_REKEY_PSEUDONYM, channelId, toEpoch(epoch)));
}

/**
 * The relay-filterable address of a server-root (base) rekey for
 * `(community, new_epoch)`, keyed by the **prior** server-root key.
 */
export function baseRekeyPseudonym(
  priorRoot: Uint8Array,
  communityId: Uint8Array,
  newEpoch: number | bigint,
): Uint8Array {
  assert32("priorRoot", priorRoot);
  assert32("communityId", communityId);
  return hkdf32(priorRoot, buildInfo(LABEL_BASE_REKEY_PSEUDONYM, communityId, toEpoch(newEpoch)));
}

/**
 * Per-recipient rekey-blob tag. The IKM is the pairwise sender↔recipient ECDH
 * secret (not the channel key), so only that pair can locate the blob and a
 * removed member cannot derive tags for pairs they are not in.
 */
export function recipientPseudonym(
  perRecipientSecret: Uint8Array,
  scope: RekeyScope,
  epoch: number | bigint,
): Uint8Array {
  assert32("perRecipientSecret", perRecipientSecret);
  return hkdf32(perRecipientSecret, buildInfo(LABEL_RECIPIENT_PSEUDONYM, rekeyScopeId32(scope), toEpoch(epoch)));
}

// ── Public-invite sub-keys (token-derived) ───────────────────────────────────

/** NIP-44 key that decrypts the public invite bundle. */
export function publicInviteKey(token: Uint8Array): Uint8Array {
  assert32("token", token);
  return hkdf32(token, buildInfo(LABEL_PUBLIC_INVITE_KEY, ZERO_ID32));
}

/** Addressable `d`-tag locator where the public invite bundle sits. */
export function publicInviteLocator(token: Uint8Array): Uint8Array {
  assert32("token", token);
  return hkdf32(token, buildInfo(LABEL_PUBLIC_INVITE_LOCATOR, ZERO_ID32));
}

/**
 * Stable signing secret key for the public invite bundle, so the owner can
 * re-post at one coordinate to rotate and joiners reject an impostor squatting
 * the locator. Reduces HKDF output to a valid secp256k1 scalar with
 * reject-and-retry — the reject branch is ~2^-128 rare but kept deterministic
 * via a counter byte appended to `info`, matching Vector's `hkdf_to_secret_key`.
 * Returns the 32-byte secret key.
 */
export function publicInviteSigner(token: Uint8Array): Uint8Array {
  assert32("token", token);
  return hkdfToSecretKey(token, buildInfo(LABEL_PUBLIC_INVITE_SIGNER, ZERO_ID32));
}

function hkdfToSecretKey(ikm: Uint8Array, baseInfo: Uint8Array): Uint8Array {
  for (let counter = 0; counter <= 0xff; counter++) {
    let info: Uint8Array;
    if (counter === 0) {
      info = baseInfo;
    } else {
      info = new Uint8Array(baseInfo.length + 1);
      info.set(baseInfo, 0);
      info[baseInfo.length] = counter;
    }
    const okm = hkdf32(ikm, info);
    if (secp256k1.utils.isValidSecretKey(okm)) return okm;
  }
  throw new Error("secp256k1 scalar rejection 256 times running is impossible");
}

// ── Concord voice sub-keys (channel-key + channel-id + epoch derived) ────────

/**
 * The secp256k1 secret key a community self-signs LiveKit voice grants with.
 * Its x-only pubkey is used directly as the LiveKit room name, so a blind
 * token broker can verify "this grant was signed by the key whose pubkey is
 * this room" without ever learning the community. Rolls with the channel epoch
 * (a rekeyed-out member can no longer derive it → can no longer mint a grant).
 * Returns the 32-byte secret key.
 */
export function voiceSigner(
  channelKey: Uint8Array,
  channelId: Uint8Array,
  epoch: number | bigint,
): Uint8Array {
  assert32("channelKey", channelKey);
  assert32("channelId", channelId);
  return hkdfToSecretKey(channelKey, buildInfo(LABEL_VOICE_SIGNER, channelId, toEpoch(epoch)));
}

/**
 * The 32-byte media key fed to LiveKit's ExternalE2EEKeyProvider, so the SFU
 * forwards encrypted frames it cannot decode. Every member holding the channel
 * key derives the identical key; on rekey the epoch bumps and a removed
 * member's old key stops decoding the audio.
 */
export function voiceE2EEKey(
  channelKey: Uint8Array,
  channelId: Uint8Array,
  epoch: number | bigint,
): Uint8Array {
  assert32("channelKey", channelKey);
  assert32("channelId", channelId);
  return hkdf32(channelKey, buildInfo(LABEL_VOICE_E2EE, channelId, toEpoch(epoch)));
}

// ── hex helper (re-exported for callers that address by hex `z` tag) ─────────

export { bytesToHex };
