/**
 * NIP-17 Private Direct Messages — Armada's modern-DM wire format.
 *
 * The classic NIP-17 pipeline, unchanged and fully interoperable:
 *
 *   rumor(unsigned kind 14/15/7/5, real author, real created_at)
 *     └ seal(kind 13, signed by the sender, nip44 to the recipient, backdated)
 *         └ wrap(kind 1059, ["p", recipient], backdated)
 *
 * ...with ONE enhancement, adopted from nostr-protocol/nips#2396: when the
 * sender holds their raw secret key, the wrap is signed with a DETERMINISTIC
 * "conversation wrap key" derived from the pairwise ECDH secret instead of a
 * throwaway random key. Both parties derive the same key, so its x-only
 * pubkey becomes a stable per-conversation address:
 *
 *   - a reader can fetch ONE conversation with `{kinds:[1059], authors:[pk]}`
 *     (plus the usual `#p` scan for everything else) instead of downloading
 *     and decrypting every wrap ever p-tagged at them — NIP-17's DoS problem;
 *   - relays can whitelist known conversation addresses without AUTH.
 *
 * DELIBERATE DEVIATION from #2396's draft: the wrap content is encrypted to
 * `conv(wrapKey, recipient)` — standard NIP-59 semantics — NOT to the pairwise
 * sender↔recipient conversation key. A vanilla NIP-17 client decrypts our
 * wraps with `nip44.decrypt(wrap.pubkey, content)` exactly as it always has,
 * so the deterministic key costs ZERO interop: legacy clients read our
 * messages without knowing anything changed, and we can `authors`-filter.
 * (#2396's draft encrypts the wrap under the pairwise key, which silently
 * breaks every existing reader; it was closed unmerged.) The key DERIVATION
 * itself follows #2396 byte-for-byte (`HKDF-extract(sharedX,
 * 'nip59-signing-key' + counter)`), so if other clients adopt the draft, the
 * conversation addresses agree.
 *
 * Signer support: SENDING with the deterministic key needs the raw secret key
 * (nsec logins). Extension/bunker logins fall back to a random ephemeral wrap
 * key — plain NIP-17, same envelope, no filterable address. RECEIVING never
 * needs the raw key: every wrap opens with the ordinary
 * `signer.nip44.decrypt(wrap.pubkey, …)` path, whatever signed it.
 *
 * First contact: a wrap to a peer we've never messaged carries an outer
 * `["k", "14"]` hint so k-aware clients can index their cold inbox
 * (`{kinds:[1059], "#p":[me], "#k":["14"]}`) — the same trick Concord direct
 * invites use (`directInvite.ts`). Established conversations omit it: the
 * conversation address already scopes them, and the hint would leak the inner
 * kind for no benefit.
 */

import { extract as hkdfExtract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getEventHash } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent, UnsignedEvent } from "nostr-tools/pure";

// ── Kinds ────────────────────────────────────────────────────────────────────

/** NIP-17 chat message rumor. */
export const KIND_DM_CHAT = 14;
/** NIP-17 file message rumor. */
export const KIND_DM_FILE = 15;
/** NIP-25 reaction rumor (NIP-17 allows reactions in the encrypted chat). */
export const KIND_DM_REACTION = 7;
/** NIP-09 delete rumor (wrapped into the conversation per NIP-17). */
export const KIND_DM_DELETE = 5;
/** NIP-59 seal. */
export const KIND_DM_SEAL = 13;
/** NIP-59 gift wrap. */
export const KIND_DM_WRAP = 1059;

/** Every rumor kind the DM plane stores and folds. */
export const DM_RUMOR_KINDS = [KIND_DM_DELETE, KIND_DM_REACTION, KIND_DM_CHAT, KIND_DM_FILE];

/** NIP-59: outer (seal + wrap) timestamps are tweaked into the past, ≤ 2 days. */
export const MAX_WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** NIP-44 hard plaintext cap; a lenient publisher mints undecryptable events. */
const NIP44_MAX_PLAINTEXT = 65_535;

function tweakedPast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * MAX_WRAP_BACKDATE_SECS);
}

// ── Signer surface ───────────────────────────────────────────────────────────

/** What sending/opening a NIP-17 DM needs (every nip44-capable login has it). */
export interface Dm17Signer {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

// ── Rumors ───────────────────────────────────────────────────────────────────

/** An unsigned rumor: a NostrEvent shape with an id but no signature. */
export interface DmRumor extends UnsignedEvent {
  id: string;
}

/**
 * Build an unsigned DM rumor. The rumor keeps the REAL author and REAL time
 * (NIP-17 requires `id` and `created_at`); only the seal/wrap are backdated.
 */
export function buildDmRumor(opts: {
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  createdAt?: number;
}): DmRumor {
  const unsigned: UnsignedEvent = {
    kind: opts.kind,
    content: opts.content,
    tags: opts.tags,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    pubkey: opts.pubkey,
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

/**
 * Tags for a kind-14 chat rumor: the receiver's `p` (NIP-17: the `p` set
 * defines the room), an optional `e` reply parent, plus any extra tags the
 * composer built (imeta, q, emoji…). The peer `p` is FIRST — readers of our
 * own copies recover the conversation partner from it (see {@link dmPeerOf}).
 */
export function dmChatTags(peer: string, opts?: { replyTo?: string; extraTags?: string[][] }): string[][] {
  const tags: string[][] = [["p", peer]];
  if (opts?.replyTo) tags.push(["e", opts.replyTo]);
  for (const t of opts?.extraTags ?? []) tags.push(t);
  return tags;
}

/**
 * Tags for a kind-7 reaction rumor targeting a message in this conversation.
 * The peer `p` leads (conversation attribution — NIP-17 receivers), then the
 * NIP-25 `e` target and `k` target-kind.
 */
export function dmReactionTags(peer: string, targetId: string, targetKind: number, extraTags?: string[][]): string[][] {
  return [["p", peer], ["e", targetId], ["k", String(targetKind)], ...(extraTags ?? [])];
}

/** Tags for a kind-5 delete rumor targeting an own rumor in this conversation. */
export function dmDeleteTags(peer: string, targetId: string, targetKind: number): string[][] {
  return [["p", peer], ["e", targetId], ["k", String(targetKind)]];
}

/**
 * The conversation partner of a rumor, from `self`'s perspective: the sender
 * for received rumors, the first `p` tag for our own copies. Undefined when
 * unattributable (an own copy with no `p` tag).
 */
export function dmPeerOf(rumor: { pubkey: string; tags: string[][] }, self: string): string | undefined {
  if (rumor.pubkey !== self) return rumor.pubkey;
  return rumor.tags.find(([name, value]) => name === "p" && value)?.[1];
}

// ── The conversation wrap key (nips#2396) ────────────────────────────────────

/** A derived per-conversation wrap keypair (both parties derive the same one). */
export interface ConversationWrapKey {
  /** secp256k1 secret key — signs the conversation's wraps. */
  sk: Uint8Array;
  /** x-only pubkey hex — the conversation's filterable wrap address. */
  pk: string;
}

/**
 * Derive the deterministic conversation wrap key per nips#2396: HKDF-extract
 * over the unhashed ECDH x-coordinate (the same `shared_x` NIP-44 hashes with
 * its own salt) with salt `nip59-signing-key`, appending an incrementing
 * counter (`nip59-signing-key1`, …) in the astronomically-rare case the output
 * isn't a valid secp256k1 scalar. Symmetric: `key(a, B) === key(b, A)`.
 *
 * Memoized — the ECDH plus point-multiply costs ~ms on phones and callers
 * re-derive on every render/poll.
 */
export function conversationWrapKey(rawSk: Uint8Array, peerPk: string): ConversationWrapKey {
  const memoKey = `${bytesToHex(rawSk)}|${peerPk}`;
  const hit = wrapKeyMemo.get(memoKey);
  if (hit) return hit;

  const sharedX = secp256k1.getSharedSecret(rawSk, hexToBytes(`02${peerPk}`)).subarray(1, 33);
  let sk: Uint8Array | undefined;
  for (let counter = 0; counter <= 0xff; counter++) {
    const salt = new TextEncoder().encode(`nip59-signing-key${counter || ""}`);
    const prk = hkdfExtract(sha256, sharedX, salt);
    if (secp256k1.utils.isValidSecretKey(prk)) {
      sk = prk;
      break;
    }
  }
  if (!sk) throw new Error("scalar rejection 256 times running is impossible");

  const key: ConversationWrapKey = { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) };
  if (wrapKeyMemo.size >= WRAP_KEY_MEMO_MAX) {
    wrapKeyMemo.delete(wrapKeyMemo.keys().next().value as string);
  }
  wrapKeyMemo.set(memoKey, key);
  return key;
}

const wrapKeyMemo = new Map<string, ConversationWrapKey>();
const WRAP_KEY_MEMO_MAX = 1024;

// ── Sealing + wrapping (sending) ─────────────────────────────────────────────

/**
 * Seal a rumor to one recipient with the sender's REAL identity: kind 13,
 * nip44-encrypted to the recipient, timestamp tweaked into the past. One
 * signer round-trip. The self-copy passes the sender's own pubkey.
 */
export async function sealDmRumor(
  rumor: DmRumor,
  recipientPk: string,
  signer: Dm17Signer,
): Promise<NostrEvent> {
  if (!signer.nip44) throw new Error("This signer can't send private messages (NIP-44 unsupported).");
  const json = JSON.stringify(rumor);
  if (new TextEncoder().encode(json).length > NIP44_MAX_PLAINTEXT) {
    throw new Error("Message is too large to encrypt.");
  }
  return signer.signEvent({
    kind: KIND_DM_SEAL,
    content: await signer.nip44.encrypt(recipientPk, json),
    tags: [],
    created_at: tweakedPast(),
  });
}

/**
 * Wrap a signed seal for one recipient. Signed by the deterministic
 * conversation wrap key when provided (nips#2396 fast path), else by a
 * single-use ephemeral key (vanilla NIP-17). Either way the content is
 * encrypted to `conv(wrapKey, recipient)`, so any NIP-17 client opens it with
 * the standard `nip44.decrypt(wrap.pubkey, content)`.
 */
export function wrapDmSeal(
  seal: NostrEvent,
  recipientPk: string,
  opts?: { wrapSk?: Uint8Array; firstContact?: boolean },
): NostrEvent {
  const wrapSk = opts?.wrapSk ?? generateSecretKey();
  const convKey = getConversationKey(wrapSk, recipientPk);
  const tags: string[][] = [["p", recipientPk]];
  // First-contact hint: lets a k-aware receiver index a cold inbox without
  // decrypting their whole gift-wrap backlog. Established conversations omit
  // it (the conversation address scopes them; don't leak the kind for free).
  if (opts?.firstContact) tags.push(["k", String(KIND_DM_CHAT)]);
  return finalizeEvent(
    {
      kind: KIND_DM_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), convKey),
      tags,
      created_at: tweakedPast(),
    },
    wrapSk,
  );
}

// ── Opening (receiving) ──────────────────────────────────────────────────────

/** A fully-opened, verified DM rumor, attributed to its conversation. */
export interface OpenedDm {
  /** The rumor id (NIP-01 hash) — the message id / dedup / display key. */
  rumorId: string;
  /** Verified author (the seal's signer; equals the rumor's claimed pubkey). */
  author: string;
  kind: number;
  content: string;
  tags: string[][];
  /** The rumor's real timestamp (seconds). */
  createdAt: number;
  /** The conversation partner from the viewer's perspective. */
  peer: string;
  /** The wrap's id (the relay-addressable carrier). */
  wrapId: string;
}

/** Reject rumors claiming to be from further in the future than this. */
const MAX_FUTURE_SKEW_SECS = 3600;

/**
 * Open a kind-1059 gift wrap addressed to `self`. Returns the verified rumor,
 * or undefined for anything this signer can't open or that fails verification
 * — a scan loop skips garbage without throwing. Rumor kinds are NOT filtered
 * here (a Concord direct invite p-tagged at us opens fine and the caller
 * ignores its kind); only structural validity is enforced:
 *
 *   1. decrypt the wrap with the wrap author's pubkey → the kind-13 seal;
 *   2. decrypt the seal with the seal author's pubkey → the rumor;
 *   3. the rumor's claimed pubkey must equal the seal's signer (NIP-59
 *      anti-spoofing — NIP-44's AEAD means a successful seal decrypt already
 *      authenticates the seal author against US, so no Schnorr verify needed);
 *   4. the rumor's id must be its NIP-01 hash (filled in when absent, rejected
 *      when it lies — an id is a display/dedup key, never trust a claimed one).
 */
export async function openDmWrap(
  wrap: NostrEvent,
  signer: Pick<Dm17Signer, "nip44">,
  self: string,
): Promise<OpenedDm | undefined> {
  if (wrap.kind !== KIND_DM_WRAP || !signer.nip44) return undefined;
  try {
    const seal = JSON.parse(await signer.nip44.decrypt(wrap.pubkey, wrap.content)) as NostrEvent;
    if (seal.kind !== KIND_DM_SEAL || typeof seal.pubkey !== "string") return undefined;

    const rumor = JSON.parse(await signer.nip44.decrypt(seal.pubkey, seal.content)) as DmRumor;
    if (rumor.pubkey !== seal.pubkey) return undefined;
    if (typeof rumor.kind !== "number" || typeof rumor.content !== "string") return undefined;
    if (!Array.isArray(rumor.tags) || typeof rumor.created_at !== "number") return undefined;
    if (rumor.created_at > Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECS) return undefined;

    const computedId = getEventHash({
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: rumor.created_at,
      pubkey: rumor.pubkey,
    });
    if (rumor.id !== undefined && rumor.id !== computedId) return undefined;

    const peer = dmPeerOf(rumor, self);
    if (!peer) return undefined;

    return {
      rumorId: computedId,
      author: rumor.pubkey,
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      createdAt: rumor.created_at,
      peer,
      wrapId: wrap.id,
    };
  } catch {
    return undefined;
  }
}

// ── Native-notification decrypt material (nips#2396) ─────────────────────────

/**
 * The two NIP-44 conversation keys the Android background service needs to open
 * one conversation's gift wraps WITHOUT the raw identity key — the exact
 * "ship a derived conversation key, never the secret key" pattern Concord V2
 * uses (see concordNotifications2.ts). Two layers, two keys:
 *
 *   - `wrapConvKey` = conv(rawSk, wrapPk): opens the OUTER wrap (kind 1059) →
 *     seal. Symmetric with the sender's conv(wrapSk, self), so it decrypts our
 *     inbound wrap regardless of who signed it.
 *   - `dmConvKey` = conv(rawSk, peerPk): opens the INNER seal (kind 13) →
 *     rumor. This is the pairwise identity conversation key; the seal is
 *     nip44-encrypted under conv(senderIdentity, self) == conv(self, sender).
 *
 * `wrapPk` is the deterministic conversation address the service filters on
 * (`{kinds:[1059], "#p":[self]}` then match author == wrapPk). Requires the
 * viewer's raw secret key (nsec logins) and a known `peerPk` (a follow), so
 * it's derivable for exactly the conversations the wire already attributes.
 *
 * SECURITY: only the two per-conversation NIP-44 keys leave the WebView, never
 * `rawSk`. Each opens exactly one conversation — the same trust surface as the
 * V2 stream `convKey` and the decrypt-at-rest rumor store.
 */
export interface Dm17NativeConv {
  /** Conversation wrap address (x-only hex) — the wrap author to match. */
  wrapPk: string;
  /** NIP-44 key (hex) opening the outer wrap → seal. */
  wrapConvKey: string;
  /** NIP-44 key (hex) opening the inner seal → rumor. */
  dmConvKey: string;
  /** The conversation peer (hex) — routing + name. */
  peer: string;
}

export function dm17NativeConv(rawSk: Uint8Array, peerPk: string): Dm17NativeConv {
  const wrapPk = conversationWrapKey(rawSk, peerPk).pk;
  return {
    wrapPk,
    wrapConvKey: bytesToHex(getConversationKey(rawSk, wrapPk)),
    dmConvKey: bytesToHex(getConversationKey(rawSk, peerPk)),
    peer: peerPk,
  };
}
