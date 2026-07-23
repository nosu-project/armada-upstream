/**
 * NIP-17 Private Direct Messages — Armada's modern-DM wire format.
 *
 * The classic NIP-17 pipeline, unchanged and fully interoperable:
 *
 *   rumor(unsigned kind 14/15/7/5, real author, real created_at)
 *     └ seal(kind 13, signed by the sender, nip44 to the recipient, backdated)
 *         └ wrap(kind 1059, ["p", recipient], backdated, single-use ephemeral key)
 *
 * The wrap is authored by a throwaway random key and its content encrypted to
 * `conv(wrapKey, recipient)` — standard NIP-59 semantics — so any NIP-17
 * client opens it with the ordinary `nip44.decrypt(wrap.pubkey, content)`.
 * The recipient is addressed by the outer `["p", recipient]` tag, so a reader
 * fetches their inbox with `{kinds:[1059], "#p":[me]}` and decrypts each wrap.
 *
 * First contact: a wrap to a peer we've never messaged carries an outer
 * `["k", "14"]` hint so k-aware clients can index their cold inbox
 * (`{kinds:[1059], "#p":[me], "#k":["14"]}`) — the same trick Concord direct
 * invites use (`directInvite.ts`). Established conversations omit it so the
 * hint doesn't leak the inner kind for no benefit.
 */

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
 * Wrap a signed seal for one recipient with a single-use ephemeral key. The
 * content is encrypted to `conv(wrapKey, recipient)`, so any NIP-17 client
 * opens it with the standard `nip44.decrypt(wrap.pubkey, content)`.
 */
export function wrapDmSeal(
  seal: NostrEvent,
  recipientPk: string,
  opts?: { firstContact?: boolean },
): NostrEvent {
  const wrapSk = generateSecretKey();
  const convKey = getConversationKey(wrapSk, recipientPk);
  const tags: string[][] = [["p", recipientPk]];
  // First-contact hint: lets a k-aware receiver index a cold inbox without
  // decrypting their whole gift-wrap backlog. Established conversations omit
  // it so it doesn't leak the inner kind for no benefit.
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
