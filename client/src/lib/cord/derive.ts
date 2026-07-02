/**
 * CORD key derivations — the experimental "next" Concord wire format from the
 * CORD-01…06 drafts (`concord/` spec repo). FROZEN for this experiment: the
 * labels below are the CORD-02 Appendix A table verbatim, plus a small set of
 * armada gap-fill labels (namespaced under the same `concord/…` family) for
 * details the drafts leave open (entity locators, edition hash).
 *
 * Construction (CORD-02 A.1, byte-identical to v1's):
 *   `HKDF-SHA256(IKM, salt=∅, info, L=32)`
 *   `info = utf8(label) || 0x00 || id32 || epoch_be` — trailing fields omitted
 *   where noted.
 *
 * The headline difference from v1: a pseudonym derivation no longer yields a
 * relay `z` tag — it yields a **group signing key** (CORD-02 A.2): the HKDF
 * output is a seed, normalized to a secp256k1 keypair whose x-only pubkey is
 * the on-wire Stream address (an `authors` filter), whose secret key signs the
 * kind-1059 wrap, and whose NIP-44 self-ECDH conversation key encrypts it.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getConversationKey } from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";

import type { RekeyScope } from "@/lib/concord/derive";
import { rekeyScopeId32 } from "@/lib/concord/derive";

// ── Purpose labels (CORD-02 Appendix A.6) ────────────────────────────────────
//
// Append new ones, never edit or reuse. These are shared wire format for the
// CORD experiment — keep in lockstep with the drafts.

const LABEL_CHANNEL = "concord/channel";
const LABEL_CONTROL = "concord/control";
const LABEL_REKEY = "concord/rekey-pseudonym";
const LABEL_BASE_REKEY = "concord/base-rekey-pseudonym";
const LABEL_RECIPIENT = "concord/recipient-pseudonym";
const LABEL_INVITE_KEY = "concord/invite-key";
const LABEL_INVITE_LOCATOR = "concord/invite-locator";
const LABEL_INVITE_SIGNER = "concord/invite-signer";

/** CORD-02 A.4: the community-id commitment label (raw concat, NOT the hkdf shape). */
const LABEL_COMMUNITY_ID = "concord/community";
/** CORD-02 A.5: the epoch-key commitment label. */
const LABEL_EPOCH_COMMITMENT = "concord/epoch-key-commitment";

// armada gap-fill labels (the drafts don't pin entity locators / edition hash;
// we keep the v1 *shapes* under the CORD label family).
const LABEL_BANLIST_LOCATOR = "concord/banlist-locator";
const LABEL_GRANT_LOCATOR = "concord/grant-locator";
/** Edition-hash domain separator (see `version.ts` — the CORD chain label). */
export const CORD_EDITION_LABEL = "concord/edition";

const ZERO_ID32 = new Uint8Array(32);
const ASCII = new TextEncoder();

// ── Core construction (identical bytes to v1's buildInfo/hkdf32) ─────────────

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

function hkdf32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), info, 32);
}

function toEpoch(epoch: number | bigint): bigint {
  return typeof epoch === "bigint" ? epoch : BigInt(epoch);
}

function assert32(name: string, b: Uint8Array): void {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
}

/**
 * CORD-02 A.3 `scalar_normalize`: reduce an HKDF output to a valid secp256k1
 * secret key with reject-and-retry (an incrementing counter byte appended to
 * `info` keeps the ~2⁻¹²⁸ reject branch deterministic across implementations).
 */
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

// ── The group signing key (CORD-02 A.2) ──────────────────────────────────────

/**
 * A derived per-(secret, id, epoch) group keypair: the whole addressing +
 * envelope material for one plane at one epoch.
 */
export interface GroupKey {
  /** The derived secp256k1 secret key — signs the kind-1059 wrap. */
  sk: Uint8Array;
  /** x-only pubkey hex — the Stream address (`authors` filter value). */
  pk: string;
  /** NIP-44 conversation key (self-ECDH) — encrypts the wrap + seal content. */
  conv: Uint8Array;
}

/** `group_key(label, secret, id, epoch)` per CORD-02 A.2. */
export function groupKey(
  label: string,
  secret: Uint8Array,
  id32: Uint8Array,
  epoch: number | bigint,
): GroupKey {
  assert32("secret", secret);
  assert32("id32", id32);
  const sk = hkdfToSecretKey(secret, buildInfo(label, id32, toEpoch(epoch)));
  const pk = getPublicKey(sk);
  const conv = getConversationKey(sk, pk);
  return { sk, pk, conv };
}

/** A Channel plane's group key (public: secret = CommunityRoot; private: the channel key). */
export function channelGroupKey(secret: Uint8Array, channelId: Uint8Array, epoch: number | bigint): GroupKey {
  return groupKey(LABEL_CHANNEL, secret, channelId, epoch);
}

/** The Control plane's group key (CORD-02 §5). */
export function controlGroupKey(root: Uint8Array, communityId: Uint8Array, epoch: number | bigint): GroupKey {
  return groupKey(LABEL_CONTROL, root, communityId, epoch);
}

/** A channel-rekey address for `(channel, newEpoch)`, keyed by the CommunityRoot (CORD-06). */
export function rekeyGroupKey(root: Uint8Array, channelId: Uint8Array, newEpoch: number | bigint): GroupKey {
  return groupKey(LABEL_REKEY, root, channelId, newEpoch);
}

/** A base-rekey address for `(community, newEpoch)`, keyed by the PRIOR CommunityRoot (CORD-06). */
export function baseRekeyGroupKey(priorRoot: Uint8Array, communityId: Uint8Array, newEpoch: number | bigint): GroupKey {
  return groupKey(LABEL_BASE_REKEY, priorRoot, communityId, newEpoch);
}

// ── Rekey blob locator (CORD-06 §2) ──────────────────────────────────────────

/**
 * A rekey blob's locator: unlike v1 (pairwise-secret IKM), CORD derives it from
 * the concatenated PUBLIC keys of the rotator and recipient —
 * `hkdf(ikm = rotator_xonly ‖ recipient_xonly, info = label ‖ 0x00 ‖ scope_id ‖ epoch_be)`.
 */
export function cordRecipientLocator(
  rotatorXonly: Uint8Array,
  recipientXonly: Uint8Array,
  scope: RekeyScope,
  newEpoch: number | bigint,
): Uint8Array {
  assert32("rotatorXonly", rotatorXonly);
  assert32("recipientXonly", recipientXonly);
  const ikm = new Uint8Array(64);
  ikm.set(rotatorXonly, 0);
  ikm.set(recipientXonly, 32);
  return hkdf32(ikm, buildInfo(LABEL_RECIPIENT, rekeyScopeId32(scope), toEpoch(newEpoch)));
}

// ── Invite sub-keys (CORD-05, token-derived; id = 0…0, no epoch) ─────────────

/** NIP-44 key that decrypts a CORD public-invite bundle. */
export function cordInviteKey(token: Uint8Array): Uint8Array {
  assert32("token", token);
  return hkdf32(token, buildInfo(LABEL_INVITE_KEY, ZERO_ID32));
}

/** Addressable `d`-tag locator where the CORD invite bundle sits. */
export function cordInviteLocator(token: Uint8Array): Uint8Array {
  assert32("token", token);
  return hkdf32(token, buildInfo(LABEL_INVITE_LOCATOR, ZERO_ID32));
}

/** Stable signing secret key for the CORD invite bundle (scalar-normalized). */
export function cordInviteSigner(token: Uint8Array): Uint8Array {
  assert32("token", token);
  return hkdfToSecretKey(token, buildInfo(LABEL_INVITE_SIGNER, ZERO_ID32));
}

// ── Entity locators (gap-fill, v1 shapes under concord/* labels) ─────────────

/** Opaque coordinate for the banlist entity (vsk=4). */
export function cordBanlistLocator(communityId: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  return hkdf32(communityId, ASCII.encode(LABEL_BANLIST_LOCATOR));
}

/** Opaque coordinate for a member's Grant entity (vsk=3). */
export function cordGrantLocator(communityId: Uint8Array, memberXonly: Uint8Array): Uint8Array {
  assert32("communityId", communityId);
  assert32("memberXonly", memberXonly);
  return hkdf32(communityId, buildInfo(LABEL_GRANT_LOCATOR, memberXonly));
}

// ── Identity commitment (CORD-02 A.4) ────────────────────────────────────────

/**
 * The self-certifying community id:
 * `SHA-256( utf8("concord/community") ‖ owner_xonly[32] ‖ owner_salt[32] )`.
 * A plain commitment (raw concat), NOT the hkdf construction.
 */
export function cordCommunityId(ownerXonly: Uint8Array, ownerSalt: Uint8Array): Uint8Array {
  assert32("ownerXonly", ownerXonly);
  assert32("ownerSalt", ownerSalt);
  const label = ASCII.encode(LABEL_COMMUNITY_ID);
  const buf = new Uint8Array(label.length + 64);
  buf.set(label, 0);
  buf.set(ownerXonly, label.length);
  buf.set(ownerSalt, label.length + 32);
  return sha256(buf);
}

/** True iff `(ownerXonly, ownerSalt)` reproduce `communityId` — the owner proof. */
export function verifyCordCommunityId(
  communityId: Uint8Array,
  ownerXonly: Uint8Array,
  ownerSalt: Uint8Array,
): boolean {
  return bytesToHex(cordCommunityId(ownerXonly, ownerSalt)) === bytesToHex(communityId);
}

// ── Epoch-key commitment (CORD-02 A.5 / CORD-06) ─────────────────────────────

/** `SHA-256("concord/epoch-key-commitment" ‖ prevEpoch_be[8] ‖ prevKey[32])`. */
export function cordEpochKeyCommitment(prevEpoch: bigint, prevKey: Uint8Array): Uint8Array {
  assert32("prevKey", prevKey);
  const label = ASCII.encode(LABEL_EPOCH_COMMITMENT);
  const buf = new Uint8Array(label.length + 8 + 32);
  buf.set(label, 0);
  new DataView(buf.buffer).setBigUint64(label.length, prevEpoch, false);
  buf.set(prevKey, label.length + 8);
  return sha256(buf);
}

export { bytesToHex };
export type { RekeyScope };
