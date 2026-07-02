/**
 * CORD rekeys (CORD-06) — kind-3303 rumors carried as stream events at
 * root-derived rekey addresses, delivering fresh keys via per-recipient blobs.
 *
 * Differences from v1:
 *   - the envelope is a CORD-01 stream (wrap signed by the rekey group key;
 *     the rotator's authorship is the SEAL signature);
 *   - a blob's LOCATOR derives from the concatenated PUBLIC keys of rotator
 *     and recipient (CORD-06 §2) — anyone can compute where a blob would sit,
 *     but only the pair's ECDH secret opens it (the wrap carries the key);
 *   - the epoch commitment label is `concord/epoch-key-commitment`.
 *
 * The blob's wrapped payload keeps v1's 72-byte bound plaintext
 * (`scopeId ‖ epoch_be ‖ newKey`) sealed under the pairwise NIP-44 secret —
 * strict scope+epoch binding defeats cross-coordinate splice.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { rekeyScopeId32, type RekeyScope } from "@/lib/concord/derive";
import { KIND_COMMUNITY_REKEY } from "@/lib/concord/kinds";
import type { RekeyBlob } from "@/lib/concord/rekey";
import { SERVER_ROOT_SCOPE_HEX } from "@/lib/concord/types";
import { baseRekeyGroupKey, cordRecipientLocator, rekeyGroupKey } from "@/lib/cord/derive";
import { buildSealTemplate, finalizeRumor, openCordStream, wrapSeal } from "@/lib/cord/stream";
import type { GroupKey } from "@/lib/cord/derive";

/** The 72-byte bound plaintext: `scopeId[32] ‖ epoch_be[8] ‖ newKey[32]`. */
function boundPlaintext(scope: RekeyScope, epoch: bigint, newKey: Uint8Array): Uint8Array {
  const pt = new Uint8Array(72);
  pt.set(rekeyScopeId32(scope), 0);
  new DataView(pt.buffer).setBigUint64(32, epoch, false);
  pt.set(newKey, 40);
  return pt;
}

// NIP-44 in nostr-tools operates on UTF-8 text; latin1-map the binary bytes.
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

/** Build one CORD rekey blob for `recipientPkHex` (locator from PUBLIC keys, CORD-06 §2). */
export function buildCordRekeyBlob(
  rotatorSk: Uint8Array,
  recipientPkHex: string,
  scope: RekeyScope,
  newEpoch: bigint,
  newKey: Uint8Array,
): RekeyBlob {
  const rotatorPk = getPublicKey(rotatorSk);
  const locator = bytesToHex(
    cordRecipientLocator(hexToBytes(rotatorPk), hexToBytes(recipientPkHex), scope, newEpoch),
  );
  const secret = getConversationKey(rotatorSk, recipientPkHex);
  const wrapped = cipherSeal(secret, bytesToLatin1(boundPlaintext(scope, newEpoch, newKey)));
  return { locator, wrapped };
}

/**
 * Open a CORD blob addressed to me: recompute my locator from the PUBLIC keys,
 * match it, then decrypt under the pairwise ECDH secret and verify the bound
 * `(scope, epoch)`. Throws on any mismatch.
 */
export function openCordRekeyBlob(
  mySk: Uint8Array,
  rotatorPkHex: string,
  scope: RekeyScope,
  newEpoch: bigint,
  blob: RekeyBlob,
): Uint8Array {
  const myPk = getPublicKey(mySk);
  const expected = bytesToHex(
    cordRecipientLocator(hexToBytes(rotatorPkHex), hexToBytes(myPk), scope, newEpoch),
  );
  if (blob.locator !== expected) {
    throw new Error("rekey blob locator does not match this recipient/scope/epoch");
  }
  const secret = getConversationKey(mySk, rotatorPkHex);
  const pt = latin1ToBytes(cipherOpen(secret, blob.wrapped));
  if (pt.length !== 72) throw new Error(`rekey blob plaintext is ${pt.length} bytes, expected 72`);
  if (bytesToHex(pt.slice(0, 32)) !== bytesToHex(rekeyScopeId32(scope))) {
    throw new Error("rekey blob scope binding mismatch (splice)");
  }
  const epochBe = new DataView(pt.buffer, pt.byteOffset + 32, 8).getBigUint64(0, false);
  if (epochBe !== newEpoch) throw new Error("rekey blob epoch binding mismatch (splice)");
  return pt.slice(40, 72);
}

// ── The 3303 stream event ────────────────────────────────────────────────────

/** The parsed contents of a CORD 3303 (after stream open + seal verify). */
export interface ParsedCordRekey {
  /** The rotator's pubkey (hex) — the SEAL signer. */
  rotator: string;
  scope: RekeyScope;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevKeyCommitment: Uint8Array;
  blobs: RekeyBlob[];
}

function scopeFromHex(hex: string): RekeyScope | undefined {
  if (hex.length !== 64 || !/^[0-9a-f]{64}$/i.test(hex)) return undefined;
  if (hex.toLowerCase() === SERVER_ROOT_SCOPE_HEX) return { kind: "server-root" };
  return { kind: "channel", channelId: hexToBytes(hex) };
}

/** Build + sign + wrap the 3303 rumor at `group` (the rekey address's group key). */
function buildCordRekeyEvent(
  rotatorSk: Uint8Array,
  group: GroupKey,
  scope: RekeyScope,
  newEpoch: bigint,
  prevEpoch: bigint,
  prevKeyCommitment: Uint8Array,
  blobs: RekeyBlob[],
): NostrEvent {
  if (newEpoch <= prevEpoch) {
    throw new Error(`rekey new_epoch ${newEpoch} must exceed prev_epoch ${prevEpoch}`);
  }
  const rumor = finalizeRumor(
    {
      kind: KIND_COMMUNITY_REKEY,
      content: JSON.stringify(blobs),
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["scope", bytesToHex(rekeyScopeId32(scope))],
        ["newepoch", newEpoch.toString()],
        ["prevepoch", prevEpoch.toString()],
        ["prevcommit", bytesToHex(prevKeyCommitment)],
      ],
    },
    getPublicKey(rotatorSk),
  );
  // Rekeys require the rotator's raw key anyway (pairwise ECDH), so the seal
  // is signed locally rather than through a remote signer.
  const seal = finalizeEvent(buildSealTemplate(rumor, group), rotatorSk);
  return wrapSeal(seal, group);
}

/** A CORD CHANNEL rekey: addressed by `rekey_group_pk(CommunityRoot, channel, newEpoch)`. */
export function buildCordChannelRekeyEvent(opts: {
  rotatorSk: Uint8Array;
  root: Uint8Array;
  channelId: Uint8Array;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevKeyCommitment: Uint8Array;
  blobs: RekeyBlob[];
}): NostrEvent {
  const group = rekeyGroupKey(opts.root, opts.channelId, opts.newEpoch);
  return buildCordRekeyEvent(
    opts.rotatorSk,
    group,
    { kind: "channel", channelId: opts.channelId },
    opts.newEpoch,
    opts.prevEpoch,
    opts.prevKeyCommitment,
    opts.blobs,
  );
}

/** A CORD BASE rekey (Refounding step 2): addressed off the PRIOR root. */
export function buildCordBaseRekeyEvent(opts: {
  rotatorSk: Uint8Array;
  priorRoot: Uint8Array;
  communityId: Uint8Array;
  newEpoch: bigint;
  prevEpoch: bigint;
  prevKeyCommitment: Uint8Array;
  blobs: RekeyBlob[];
}): NostrEvent {
  const group = baseRekeyGroupKey(opts.priorRoot, opts.communityId, opts.newEpoch);
  return buildCordRekeyEvent(
    opts.rotatorSk,
    group,
    { kind: "server-root" },
    opts.newEpoch,
    opts.prevEpoch,
    opts.prevKeyCommitment,
    opts.blobs,
  );
}

/**
 * Open + verify a CORD 3303 stream event under the rekey address's group key.
 * Does NOT check the rotator's authority or open blobs — callers do both.
 */
export function openCordRekeyEvent(outer: NostrEvent, group: GroupKey): ParsedCordRekey {
  const { rumor, author } = openCordStream(outer, group);
  if (rumor.kind !== KIND_COMMUNITY_REKEY) throw new Error("rekey rumor is not kind 3303");

  const get = (name: string) => rumor.tags.find((t) => t[0] === name)?.[1];
  const scope = scopeFromHex(get("scope") ?? "");
  if (!scope) throw new Error("rekey missing/invalid scope");
  const newEpoch = BigInt(get("newepoch") ?? "0");
  const prevEpoch = BigInt(get("prevepoch") ?? "0");
  const commitHex = get("prevcommit") ?? "";
  const prevKeyCommitment = commitHex.length === 64 ? hexToBytes(commitHex) : new Uint8Array(32);
  const blobs = JSON.parse(rumor.content) as RekeyBlob[];
  if (!Array.isArray(blobs) || blobs.length > 120) throw new Error("rekey blob array invalid/oversized");

  return { rotator: author, scope, newEpoch, prevEpoch, prevKeyCommitment, blobs };
}
