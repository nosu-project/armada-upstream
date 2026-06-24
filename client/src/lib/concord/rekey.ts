/**
 * Rekey blob primitive — ported from Vector's `community/rekey.rs`.
 *
 * A rotation (a private removal, re-founding, or scheduled rekey) mints a
 * fresh-random key for the next epoch and delivers it to every member who stays,
 * one per-recipient blob each. Each blob is located by
 * `recipientPseudonym(pairwiseSecret, scope, epoch)` (only the sender↔recipient
 * pair can compute it) and wrapped under the same pairwise secret. The wrapped
 * plaintext binds `(scope, epoch)` so a blob can't be spliced into another
 * coordinate.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getConversationKey } from "nostr-tools/nip44";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { recipientPseudonym, rekeyScopeId32, type RekeyScope } from "@/lib/concord/derive";

/** One located, wrapped rekey blob — the unit a 3303 Rekey event carries N of. */
export interface RekeyBlob {
  /** recipientPseudonym hex (where the recipient finds it). */
  locator: string;
  /** base64 NIP-44 ciphertext of `scopeId ‖ epoch ‖ newKey`. */
  wrapped: string;
}

/**
 * The pairwise sender↔recipient secret: the NIP-44 v2 conversation key,
 * HKDF-extracted from the ECDH shared point. Symmetric, so the recipient
 * recomputes exactly what the sender used, for both the locator and the wrap key.
 * `senderSk` is the rotator's identity secret; `recipientPkHex` the lowercase hex
 * x-only pubkey.
 */
export function rekeyPairwiseSecret(senderSk: Uint8Array, recipientPkHex: string): Uint8Array {
  return getConversationKey(senderSk, recipientPkHex);
}

/** The 72-byte bound plaintext: `scopeId[32] ‖ epoch_be[8] ‖ newKey[32]`. */
function boundPlaintext(scope: RekeyScope, epoch: bigint, newKey: Uint8Array): Uint8Array {
  const pt = new Uint8Array(72);
  pt.set(rekeyScopeId32(scope), 0);
  new DataView(pt.buffer).setBigUint64(32, epoch, false);
  pt.set(newKey, 40);
  return pt;
}

/**
 * Build one rekey blob: the fresh `newKey` for `(scope, epoch)`, located +
 * wrapped to `recipientPkHex`. The plaintext is passed as a binary string to the
 * cipher (NIP-44 operates on UTF-8 text in nostr-tools, so we encode the bytes as
 * a latin1 string to preserve them losslessly).
 */
export function buildRekeyBlob(
  senderSk: Uint8Array,
  recipientPkHex: string,
  scope: RekeyScope,
  epoch: bigint,
  newKey: Uint8Array,
): RekeyBlob {
  const secret = rekeyPairwiseSecret(senderSk, recipientPkHex);
  const locator = bytesToHex(recipientPseudonym(secret, scope, epoch));
  const pt = boundPlaintext(scope, epoch, newKey);
  const wrapped = cipherSeal(secret, bytesToLatin1(pt));
  return { locator, wrapped };
}

/**
 * Open a blob addressed to me: recompute the pairwise secret from `(mySk,
 * senderPk)`, confirm the locator matches this pair+scope+epoch, decrypt, and
 * verify the wrapped plaintext binds the SAME `(scope, epoch)`. Throws on any
 * mismatch (wrong sender, wrong coordinate, tamper, splice).
 */
export function openRekeyBlob(
  mySk: Uint8Array,
  senderPkHex: string,
  scope: RekeyScope,
  epoch: bigint,
  blob: RekeyBlob,
): Uint8Array {
  const secret = rekeyPairwiseSecret(mySk, senderPkHex);
  const expected = bytesToHex(recipientPseudonym(secret, scope, epoch));
  if (blob.locator !== expected) {
    throw new Error("rekey blob locator does not match this recipient/scope/epoch");
  }
  const pt = latin1ToBytes(cipherOpen(secret, blob.wrapped));
  if (pt.length !== 72) throw new Error(`rekey blob plaintext is ${pt.length} bytes, expected 72`);
  if (bytesToHex(pt.slice(0, 32)) !== bytesToHex(rekeyScopeId32(scope))) {
    throw new Error("rekey blob scope binding mismatch (splice)");
  }
  const epochBe = new DataView(pt.buffer, pt.byteOffset + 32, 8).getBigUint64(0, false);
  if (epochBe !== epoch) throw new Error("rekey blob epoch binding mismatch (splice)");
  return pt.slice(40, 72);
}

/**
 * A commitment to the prior epoch's key (fork detection):
 * `SHA256("vector-community/v1/epoch-key-commitment" ‖ prevEpoch_be ‖ prevKey)`.
 */
export function epochKeyCommitment(prevEpoch: bigint, prevKey: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode("vector-community/v1/epoch-key-commitment");
  const epochBe = new Uint8Array(8);
  new DataView(epochBe.buffer).setBigUint64(0, prevEpoch, false);
  const buf = new Uint8Array(label.length + 8 + 32);
  buf.set(label, 0);
  buf.set(epochBe, label.length);
  buf.set(prevKey, label.length + 8);
  return sha256(buf);
}

// NIP-44 in nostr-tools encrypts/decrypts UTF-8 text. To carry the 72 binary
// bytes losslessly we map each byte to a code point 0..255 (latin1) and back.
function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
}
function latin1ToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

// ── Rekey EVENT layer (kind 3303 carrying N blobs) ───────────────────────────

import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { baseRekeyPseudonym, rekeyPseudonym } from "@/lib/concord/derive";
import { KIND_COMMUNITY_REKEY } from "@/lib/concord/kinds";
import { SERVER_ROOT_SCOPE_HEX } from "@/lib/concord/types";

const PROTOCOL_VERSION = "1";

/** Encode a scope to its 32-byte-hex `scope` tag (channel id, or the all-zero server-root sentinel). */
function scopeToHex(scope: RekeyScope): string {
  return bytesToHex(rekeyScopeId32(scope));
}

/** Decode a `scope` tag hex back to a RekeyScope (all-zero ⇒ server root). */
function scopeFromHex(hex: string): RekeyScope | undefined {
  if (hex.length !== 64 || !/^[0-9a-f]{64}$/i.test(hex)) return undefined;
  if (hex.toLowerCase() === SERVER_ROOT_SCOPE_HEX) return { kind: "server-root" };
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { kind: "channel", channelId: bytes };
}

/** The parsed contents of a 3303 rekey outer (after server-root decrypt + inner verify). */
export interface ParsedRekey {
  /** The rotator's pubkey (hex), from the inner signature. */
  rotator: string;
  scope: RekeyScope;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevKeyCommitment: Uint8Array;
  blobs: RekeyBlob[];
}

/** Build the rotator-signed INNER rekey event (kind 3303), shared by both rekey kinds. */
function buildRekeyInner(
  rotatorSk: Uint8Array,
  scope: RekeyScope,
  newEpoch: bigint,
  prevEpoch: bigint,
  prevKeyCommitment: Uint8Array,
  blobs: RekeyBlob[],
): NostrEvent {
  if (newEpoch <= prevEpoch) {
    throw new Error(`rekey new_epoch ${newEpoch} must exceed prev_epoch ${prevEpoch}`);
  }
  const template: EventTemplate = {
    kind: KIND_COMMUNITY_REKEY,
    content: JSON.stringify(blobs),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["scope", scopeToHex(scope)],
      ["newepoch", newEpoch.toString()],
      ["prevepoch", prevEpoch.toString()],
      ["prevcommit", bytesToHex(prevKeyCommitment)],
    ],
  };
  return finalizeEvent(template, rotatorSk);
}

/** Seal a signed inner rekey into the ephemeral-signed outer, addressed by `addressHex`. */
function sealRekeyOuter(inner: NostrEvent, envelopeKey: Uint8Array, addressHex: string): NostrEvent {
  const content = cipherSeal(envelopeKey, JSON.stringify(inner));
  const ephemeral = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_COMMUNITY_REKEY,
      content,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["z", addressHex], ["v", PROTOCOL_VERSION]],
    },
    ephemeral,
  );
}

/**
 * Build a signed 3303 CHANNEL rekey: enveloped under the STABLE server-root key
 * and addressed by `rekeyPseudonym(serverRoot, channelId, newEpoch)`, so any
 * member recovers any epoch independently. The new channel key lives only in the
 * per-recipient ECDH `blobs` — a removed member reads the header but recovers no
 * key.
 */
export function buildChannelRekeyEvent(opts: {
  rotatorSk: Uint8Array;
  serverRoot: Uint8Array;
  channelId: Uint8Array;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevKeyCommitment: Uint8Array;
  blobs: RekeyBlob[];
}): NostrEvent {
  const scope: RekeyScope = { kind: "channel", channelId: opts.channelId };
  const inner = buildRekeyInner(opts.rotatorSk, scope, opts.newEpoch, opts.prevEpoch, opts.prevKeyCommitment, opts.blobs);
  const address = bytesToHex(rekeyPseudonym(opts.serverRoot, opts.channelId, opts.newEpoch));
  return sealRekeyOuter(inner, opts.serverRoot, address);
}

/**
 * Build a signed 3303 SERVER-ROOT rekey (base rotation): enveloped under the
 * PRIOR root and addressed by `baseRekeyPseudonym(priorRoot, communityId,
 * newEpoch)`. The new root reaches members only via ECDH blobs.
 */
export function buildServerRootRekeyEvent(opts: {
  rotatorSk: Uint8Array;
  priorRoot: Uint8Array;
  communityId: Uint8Array;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevKeyCommitment: Uint8Array;
  blobs: RekeyBlob[];
}): NostrEvent {
  const scope: RekeyScope = { kind: "server-root" };
  const inner = buildRekeyInner(opts.rotatorSk, scope, opts.newEpoch, opts.prevEpoch, opts.prevKeyCommitment, opts.blobs);
  const address = bytesToHex(baseRekeyPseudonym(opts.priorRoot, opts.communityId, opts.newEpoch));
  return sealRekeyOuter(inner, opts.priorRoot, address);
}

/**
 * Open + verify a 3303 rekey outer with the server-root key (which every member
 * always holds): decrypt, parse the inner, verify the rotator's inner signature,
 * and read the rekey fields. Does NOT check authority or open any blob — the
 * caller does both. Throws on a wrong key (non-member) or tampering.
 */
export function openRekeyEvent(outer: NostrEvent, envelopeKey: Uint8Array): ParsedRekey {
  if (outer.kind !== KIND_COMMUNITY_REKEY) throw new Error("not a rekey outer (kind != 3303)");
  const v = outer.tags.find((t) => t[0] === "v")?.[1];
  if (v !== PROTOCOL_VERSION) throw new Error(`unsupported rekey version: ${v}`);

  const json = cipherOpen(envelopeKey, outer.content);
  const inner = JSON.parse(json) as NostrEvent;
  if (!verifyEvent(inner)) throw new Error("rekey inner signature invalid");
  if (inner.kind !== KIND_COMMUNITY_REKEY) throw new Error("rekey inner is not kind 3303");

  const scopeHex = inner.tags.find((t) => t[0] === "scope")?.[1];
  const scope = scopeHex ? scopeFromHex(scopeHex) : undefined;
  if (!scope) throw new Error("rekey missing/invalid scope");
  const newEpoch = BigInt(inner.tags.find((t) => t[0] === "newepoch")?.[1] ?? "0");
  const prevEpoch = BigInt(inner.tags.find((t) => t[0] === "prevepoch")?.[1] ?? "0");
  const commitHex = inner.tags.find((t) => t[0] === "prevcommit")?.[1] ?? "";
  const prevKeyCommitment = hexTo32(commitHex);
  const blobs = JSON.parse(inner.content) as RekeyBlob[];

  return { rotator: inner.pubkey, scope, newEpoch, prevEpoch, prevKeyCommitment, blobs };
}

function hexTo32(hex: string): Uint8Array {
  const b = new Uint8Array(32);
  if (hex.length === 64) for (let i = 0; i < 32; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

export { verifyEvent };
