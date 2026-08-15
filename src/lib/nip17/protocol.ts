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
 * GROUP CONVERSATIONS are the same wire format with more than one `p` on the
 * rumor: the `p` set defines the room, and one seal+wrap is minted PER
 * participant (plus the sender's own copy), each addressed to that participant
 * and delivered to their own kind-10050 inbox. There is no group event, no
 * shared key and no membership list — see the conversation-identity note above
 * {@link dmPeersOf} for what that does and does not buy.
 *
 * First contact: a wrap to a peer we've never messaged carries an outer
 * `["k", "14"]` hint so k-aware clients can index their cold inbox
 * (`{kinds:[1059], "#p":[me], "#k":["14"]}`) — the same trick Concord direct
 * invites use (`directInvite.ts`). Established conversations omit it so the
 * hint doesn't leak the inner kind for no benefit.
 *
 * DISAPPEARING MESSAGES (Armada extension). A conversation can carry a
 * disappearing-message timer, set by either participant with a kind-1740 rumor
 * (see {@link KIND_DM_TIMER}). While a timer is set, every message/file/
 * reaction rumor in the conversation is stamped with a NIP-40 `["expiration",
 * "<unix>"]` tag AT ALL THREE LEVELS — rumor, seal and wrap — so:
 *
 *   - relays that honor NIP-40 drop the gift wrap on their own (the outer tag
 *     is the only one they can see);
 *   - a reader that never saw the wrap still learns the deadline from the seal
 *     and rumor, which survive decryption and are what this client enforces.
 *
 * Enforcement is entirely client-side and does not trust relays: an expired
 * envelope is rejected at {@link openDmWrap} — before it can be persisted —
 * and every read path filters again (see `dm17Store.ts`). The deadline is
 * absolute (`sent_at + timer`), NOT Signal's read-triggered countdown: NIP-40
 * has only one timestamp and a receiver-started clock can't be expressed in it.
 */

import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getEventHash } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent, UnsignedEvent } from "nostr-tools/pure";

import type { NostrRumor } from "@/lib/nostrRumor";

import { dmConvKey, dmPeersOf } from "./conversation";

// ── Kinds ────────────────────────────────────────────────────────────────────

/** NIP-17 chat message rumor. */
export const KIND_DM_CHAT = 14;
/** NIP-17 file message rumor. */
export const KIND_DM_FILE = 15;
/** NIP-25 reaction rumor (NIP-17 allows reactions in the encrypted chat). */
export const KIND_DM_REACTION = 7;
/** NIP-09 delete rumor (wrapped into the conversation per NIP-17). */
export const KIND_DM_DELETE = 5;
/**
 * Disappearing-messages timer change (Armada extension; the mnemonic is
 * NIP-17 ⊕ NIP-40). Either participant publishes one to set the conversation's
 * timer; the newest one in the thread wins, and `0` means off. Carries the
 * peer `p` and a `["timer", "<seconds>"]` tag; the content is empty.
 *
 * A timer rumor is NEVER stamped with an expiration of its own: it is the
 * conversation's shared state, so losing it would silently un-set the timer on
 * a device that resynced afterwards. It leaks nothing beyond "a timer changed"
 * — the message bodies it governs are the part that disappears.
 */
export const KIND_DM_TIMER = 1740;
/**
 * Typing indicator (Armada extension). The same rumor kind Concord uses for
 * its channel typing signal (CORD-02 Appendix B), reused here so one kind means
 * one thing everywhere; only the envelope differs. Empty content, peer `p` tag,
 * no expiration — the event's existence IS the signal, and it is never stored.
 *
 * Deliberately NOT in {@link DM_RUMOR_KINDS}: a typing signal must never reach
 * the rumor store or the thread fold. It lives for {@link TYPING_WINDOW_SECS}
 * in memory and then it's gone.
 */
export const KIND_DM_TYPING = 23311;
/** NIP-59 seal. */
export const KIND_DM_SEAL = 13;
/** NIP-59 gift wrap. */
export const KIND_DM_WRAP = 1059;
/**
 * Voice-call signal (Armada extension; see `src/lib/dmCall.ts` for the whole
 * scheme). The content is the phase — "offer", "answer", "decline", "end" —
 * and the tags carry the call binding (and, on an offer, the per-call secret
 * + broker rendezvous hint). Rides the EPHEMERAL kind-21059 wrap, like every
 * other live signal in this codebase (typing, Concord voice presence): a
 * relay broadcasts it and stores nothing, so no record that a call happened
 * ever sits at rest anywhere — a durable wrap would leave one, and its
 * NIP-40 tag would even betray the true send time through the backdating.
 * Every live listener still rings: the web provider and the Android relay
 * service each hold a standing 21059 subscription. What is traded away is a
 * missed-call record on a device that was OFFLINE during the ring window,
 * which is exactly the trade typing indicators already make.
 *
 * Deliberately NOT in {@link DM_RUMOR_KINDS}: a call signal is state, not
 * conversation history, and it must never reach the rumor store — it is
 * dispatched to the live call layer at open time and then it's gone.
 */
export const KIND_DM_CALL = 23314;
/**
 * Ephemeral gift wrap (Armada extension, mirroring Concord's kind-21059
 * wrap). Relays in the 20000–29999 range broadcast to current subscribers and
 * store nothing, which is the whole point: a durable kind-1059 typing signal
 * would pile up in the recipient's inbox forever and be replayed by every cold
 * backfill. The inside is an ordinary NIP-59 seal, so the crypto is unchanged.
 */
export const KIND_DM_WRAP_EPHEMERAL = 21059;

/** How long a typing signal stays live before it ages out. */
export const TYPING_WINDOW_SECS = 8;

/** Every rumor kind the DM plane stores and folds. */
export const DM_RUMOR_KINDS = [
  KIND_DM_DELETE,
  KIND_DM_REACTION,
  KIND_DM_CHAT,
  KIND_DM_FILE,
  KIND_DM_TIMER,
];

/** NIP-59: outer (seal + wrap) timestamps are tweaked into the past, ≤ 2 days. */
export const MAX_WRAP_BACKDATE_SECS = 2 * 24 * 60 * 60;

/** NIP-44 hard plaintext cap; a lenient publisher mints undecryptable events. */
const NIP44_MAX_PLAINTEXT = 65_535;

function tweakedPast(): number {
  return Math.floor(Date.now() / 1000) - Math.floor(Math.random() * MAX_WRAP_BACKDATE_SECS);
}

// ── NIP-40 expiration ────────────────────────────────────────────────────────

/**
 * The NIP-40 deadline (unix seconds) carried by these tags, or undefined when
 * there is none. A malformed / non-finite value is treated as absent rather
 * than as "expired": a garbage tag must not be able to hide a message.
 */
export function expirationOf(tags: readonly string[][]): number | undefined {
  const raw = tags.find(([name]) => name === "expiration")?.[1];
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) ? secs : undefined;
}

/** Whether these tags carry a NIP-40 deadline that has already passed. */
export function isExpired(tags: readonly string[][], nowSecs = Math.floor(Date.now() / 1000)): boolean {
  const at = expirationOf(tags);
  return at !== undefined && at <= nowSecs;
}

/** Append a NIP-40 `expiration` tag when `expiresAt` is set (else pass through). */
export function withExpiration(tags: string[][], expiresAt?: number): string[][] {
  return expiresAt === undefined ? tags : [...tags, ["expiration", String(Math.floor(expiresAt))]];
}

// ── Signer surface ───────────────────────────────────────────────────────────

/** What sending/opening a NIP-17 DM needs (every nip44-capable login has it). */
export interface Dm17Signer {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    /**
     * `opts.cache: false` asks a caching signer (see `AppSigner`) NOT to
     * persist this plaintext — used for expiring envelopes, whose whole point
     * is to leave nothing at rest. Signers without a cache ignore it.
     */
    decrypt(pubkey: string, ciphertext: string, opts?: { cache?: boolean }): Promise<string>;
  };
}

// ── Rumors ───────────────────────────────────────────────────────────────────

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
}): NostrRumor {
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
 * Tags for a kind-14 chat rumor: one `p` per receiver (NIP-17: the `p` set
 * defines the room), an optional `e` reply parent, plus any extra tags the
 * composer built (imeta, q, emoji…). The `p` set leads — readers of our own
 * copies recover the conversation from it (see {@link dmPeersOf}).
 */
export function dmChatTags(
  peers: readonly string[],
  opts?: { replyTo?: string; extraTags?: string[][]; expiresAt?: number },
): string[][] {
  const tags: string[][] = peers.map((peer) => ["p", peer]);
  if (opts?.replyTo) tags.push(["e", opts.replyTo]);
  for (const t of opts?.extraTags ?? []) tags.push(t);
  return withExpiration(tags, opts?.expiresAt);
}

/**
 * Tags for a kind-7 reaction rumor targeting a message in this conversation.
 * The `p` set leads (conversation attribution — NIP-17 receivers), then the
 * NIP-25 `e` target and `k` target-kind.
 */
export function dmReactionTags(
  peers: readonly string[],
  targetId: string,
  targetKind: number,
  extraTags?: string[][],
  expiresAt?: number,
): string[][] {
  return withExpiration(
    [
      ...peers.map((peer) => ["p", peer]),
      ["e", targetId],
      ["k", String(targetKind)],
      ...(extraTags ?? []),
    ],
    expiresAt,
  );
}

/**
 * Tags for a kind-5 delete rumor targeting an own rumor in this conversation.
 * Deliberately NEVER expiring: a delete is a tombstone, and its target may
 * have been sent under a longer timer (or none at all) — an expiring delete
 * would let a message that outlives it come back.
 */
export function dmDeleteTags(
  peers: readonly string[],
  targetId: string,
  targetKind: number,
): string[][] {
  return [...peers.map((peer) => ["p", peer]), ["e", targetId], ["k", String(targetKind)]];
}

/** The two rumors that make one optional NIP-17 edit operation. */
export interface DmEditRumors {
  /** New kind-14 message carrying the edited content at the original timestamp. */
  replacement: NostrRumor;
  /** Kind-5 tombstone for the superseded message. */
  deletion: NostrRumor;
}

/**
 * Build the edit form NIP-17 specifies: delete the old rumor and publish a new
 * kind-14 rumor with the SAME `created_at`. The replacement keeps the room,
 * reply/citation, media and expiration tags verbatim; only Armada's display
 * marker is refreshed. Foreign clients that implement the optional edit rule
 * can fold the pair, while clients that do not still see an ordinary deletion
 * and message.
 */
export function buildDmEditRumors(
  original: NostrRumor,
  peers: readonly string[],
  content: string,
  editedAt = Math.floor(Date.now() / 1000),
): DmEditRumors {
  if (original.kind !== KIND_DM_CHAT) throw new Error("Only NIP-17 chat messages can be edited");

  const editTimestamp = Math.floor(editedAt);
  const replacement = buildDmRumor({
    kind: KIND_DM_CHAT,
    content,
    tags: [
      ...original.tags.filter(([name]) => name !== "edited"),
      ["edited", String(editTimestamp)],
    ],
    pubkey: original.pubkey,
    createdAt: original.created_at,
  });
  const deletion = buildDmRumor({
    kind: KIND_DM_DELETE,
    content: "",
    tags: dmDeleteTags(peers, original.id, original.kind),
    pubkey: original.pubkey,
    createdAt: editTimestamp,
  });

  return { replacement, deletion };
}

/** Tags for a kind-1740 timer-change rumor. `seconds` of 0 turns it off. */
export function dmTimerTags(peers: readonly string[], seconds: number): string[][] {
  return [
    ...peers.map((peer) => ["p", peer]),
    ["timer", String(Math.max(0, Math.floor(seconds)))],
  ];
}

/**
 * Tags for a kind-23311 typing rumor: the `p` set and nothing else. No
 * `expiration` — the freshness check is the rumor's own `created_at` against
 * {@link TYPING_WINDOW_SECS}, and a NIP-40 tag would only add a relay-visible
 * hint about a wrap the relay is already forbidden to keep.
 */
export function dmTypingTags(peers: readonly string[]): string[][] {
  return peers.map((peer) => ["p", peer]);
}

/**
 * The timer (seconds; 0 = off) a kind-1740 rumor sets, or undefined when the
 * tag is missing/malformed — an unreadable timer change must not be mistaken
 * for "turn it off".
 */
export function dmTimerSeconds(rumor: { tags: readonly string[][] }): number | undefined {
  const raw = rumor.tags.find(([name]) => name === "timer")?.[1];
  if (raw === undefined) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : undefined;
}

// ── Conversation identity ────────────────────────────────────────────────────
//
// Lives in `conversation.ts`, which has no imports — `db/termPolicies.ts` needs
// the derivation and is bundled into the Electron main process, which has no
// business linking this module's crypto to file a database row. Re-exported
// here so every existing caller keeps its one import.

export {
  DM_PEER_SEP,
  dmConvKey,
  dmConvKeyOf,
  dmConvPeers,
  dmPeersOf,
  isDmGroupKey,
} from "./conversation";

// ── Sealing + wrapping (sending) ─────────────────────────────────────────────

/**
 * Seal a rumor to one recipient with the sender's REAL identity: kind 13,
 * nip44-encrypted to the recipient, timestamp tweaked into the past. One
 * signer round-trip. The self-copy passes the sender's own pubkey.
 *
 * A rumor carrying a NIP-40 `expiration` propagates it onto the seal, so a
 * reader learns the deadline without having to trust the (relay-visible) wrap.
 */
export async function sealDmRumor(
  rumor: NostrRumor,
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
    tags: withExpiration([], expirationOf(rumor.tags)),
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
  opts?: { firstContact?: boolean; expiresAt?: number },
): NostrEvent {
  const wrapSk = generateSecretKey();
  const convKey = getConversationKey(wrapSk, recipientPk);
  const tags: string[][] = [["p", recipientPk]];
  // First-contact hint: lets a k-aware receiver index a cold inbox without
  // decrypting their whole gift-wrap backlog. Established conversations omit
  // it so it doesn't leak the inner kind for no benefit.
  if (opts?.firstContact) tags.push(["k", String(KIND_DM_CHAT)]);
  // The outer NIP-40 tag is the ONLY expiry a relay can act on, so a
  // disappearing message asks the relays to delete their copy too. It reveals
  // no more than the wrap already does (a timestamped envelope to one `p`).
  return finalizeEvent(
    {
      kind: KIND_DM_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), convKey),
      tags: withExpiration(tags, opts?.expiresAt ?? expirationOf(seal.tags)),
      created_at: tweakedPast(),
    },
    wrapSk,
  );
}

/**
 * Wrap a signed seal in an EPHEMERAL (kind-21059) gift wrap — same single-use
 * key and same NIP-44 conversation key as {@link wrapDmSeal}, so a reader opens
 * it identically; only the outer kind and the timestamp differ.
 *
 * The timestamp is NOT backdated. NIP-59's random ≤2-day tweak exists to blur
 * *when* a stored message was sent; an ephemeral wrap is never stored, is
 * meaningless once {@link TYPING_WINDOW_SECS} has passed, and some relays drop
 * far-past events outright — so a real `created_at` is both required and costs
 * nothing extra. What the relay learns from a 21059 is that someone is sending
 * this `p` a live signal right now; the outer kind already says that, and the
 * sender stays hidden behind the throwaway wrap key either way.
 */
export function wrapDmSealEphemeral(seal: NostrEvent, recipientPk: string): NostrEvent {
  const wrapSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_DM_WRAP_EPHEMERAL,
      content: nip44Encrypt(JSON.stringify(seal), getConversationKey(wrapSk, recipientPk)),
      tags: [["p", recipientPk]],
      created_at: Math.floor(Date.now() / 1000),
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
  /**
   * The conversation's participants from the viewer's perspective — everyone
   * but them, sorted. One entry for a 1:1; `[self]` for Note to Self. See
   * {@link dmPeersOf}.
   */
  peers: string[];
  /** The wrap's id (the relay-addressable carrier). */
  wrapId: string;
}

/** The conversation key of an opened rumor. Shorthand for the common pair. */
export function dmConvKeyOfOpened(opened: Pick<OpenedDm, "peers">): string {
  return dmConvKey(opened.peers);
}

/** The NIP-40 deadline this opened rumor disappears at, if any. */
export function dmExpiresAt(opened: Pick<OpenedDm, "tags">): number | undefined {
  return expirationOf(opened.tags);
}

/** Reject rumors claiming to be from further in the future than this. */
const MAX_FUTURE_SKEW_SECS = 3600;

/**
 * Open a kind-1059 gift wrap addressed to `self` (or, with `opts.wrapKind`, an
 * ephemeral kind-21059 one — the layers inside are identical). Returns the
 * verified rumor,
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
 *
 * Disappearing messages: a NIP-40 `expiration` that has already passed on the
 * wrap, the seal OR the rumor rejects the whole envelope here — the earliest
 * point that has the plaintext, and BEFORE any caller can persist it. Relays
 * are not trusted to have dropped it, and neither is the outer tag alone (a
 * sender could strip it): all three levels are checked. An expiring envelope
 * also opts out of the signer's persistent decrypt cache, so the plaintext of
 * a message that is meant to vanish is never written to disk on the way in.
 */
export async function openDmWrap(
  wrap: NostrEvent,
  signer: Pick<Dm17Signer, "nip44">,
  self: string,
  opts?: { wrapKind?: number; cache?: boolean },
): Promise<OpenedDm | undefined> {
  if (wrap.kind !== (opts?.wrapKind ?? KIND_DM_WRAP) || !signer.nip44) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (isExpired(wrap.tags, now)) return undefined;
  try {
    // `cache: false` opts the whole envelope out of the signer's persistent
    // decrypt cache — what the ephemeral (typing) plane asks for, so a signal
    // that exists for 8 seconds doesn't write anything to disk.
    const wrapCache = opts?.cache !== false && expirationOf(wrap.tags) === undefined;
    const seal = JSON.parse(
      await signer.nip44.decrypt(wrap.pubkey, wrap.content, { cache: wrapCache }),
    ) as NostrEvent;
    if (seal.kind !== KIND_DM_SEAL || typeof seal.pubkey !== "string") return undefined;
    if (!Array.isArray(seal.tags) || isExpired(seal.tags, now)) return undefined;

    const sealCache = wrapCache && expirationOf(seal.tags) === undefined;
    const rumor = JSON.parse(
      await signer.nip44.decrypt(seal.pubkey, seal.content, { cache: sealCache }),
    ) as NostrRumor;
    if (rumor.pubkey !== seal.pubkey) return undefined;
    if (typeof rumor.kind !== "number" || typeof rumor.content !== "string") return undefined;
    if (!Array.isArray(rumor.tags) || typeof rumor.created_at !== "number") return undefined;
    if (rumor.created_at > now + MAX_FUTURE_SKEW_SECS) return undefined;
    if (isExpired(rumor.tags, now)) return undefined;

    const computedId = getEventHash({
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: rumor.created_at,
      pubkey: rumor.pubkey,
    });
    if (rumor.id !== undefined && rumor.id !== computedId) return undefined;

    const peers = dmPeersOf(rumor, self);
    if (!peers) return undefined;

    return {
      rumorId: computedId,
      author: rumor.pubkey,
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      createdAt: rumor.created_at,
      peers,
      wrapId: wrap.id,
    };
  } catch {
    return undefined;
  }
}
