/**
 * Pins — CORD-04 §7. A pin does not quote a message; it proves one.
 *
 * One Pin List per Channel on the Control Plane (vsk 11, coordinate
 * `pins_locator(community_id, channel_id)`), replaced entire per edit like the
 * Banlist. Each entry carries the original kind-20013 seal verbatim plus the
 * message's disclosed NIP-44 keys, so any reader able to open the list's form
 * verifies author, words, Channel, and signed time — holding no history and no
 * old keys. Compaction re-wraps the head across rotations, which is the whole
 * point of the placement.
 */

import { getEventHash, verifyEvent } from "nostr-tools/pure";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";

import type { NostrEvent } from "nostr-tools/pure";

import {
  decodeMessageKeys,
  decryptWithDisclosedKeys,
  discloseKeysFor,
  encodeMessageKeys,
} from "@/concord-v2/lib/nip44keys";
import { KIND_COMMENT, KIND_EDIT, KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord-v2/lib/kinds";
import type { OpenedEvent } from "@/concord-v2/lib/stream";
import type { NostrRumor } from "@/lib/nostrRumor";

/** Structural caps (CORD-04 §7) — a violating edition reads as an EMPTY list. */
export const PIN_MAX_ENTRIES = 25;
export const PIN_MAX_CONTENT_BYTES = 32_768;

export interface PinEntry {
  /** The original kind-20013 seal event: fields carried exactly, content string unaltered. */
  seal: NostrEvent;
  /** 76-byte lowercase hex: chacha_key[32] || chacha_nonce[12] || hmac_key[32]. */
  keys: string;
  /** Optional, UNVERIFIED locator hint for jump-to-context. */
  wrap?: string;
  /**
   * The newest provable Edit, for readers who hold no Chat plane (§7 Edits).
   * At most one, ever: Edits target the ORIGINAL rumor and never each other, so
   * a later Edit REPLACES this rather than appending.
   */
  edit?: { seal: NostrEvent; keys: string };
}

/** A pin that passed the full §7 verification — safe to render. */
export interface VerifiedPin {
  /** Recomputed from the decrypted bytes; never the embedded field. */
  rumorId: string;
  /** The seal's signer == the rumor's author. */
  author: string;
  kind: number;
  content: string;
  tags: string[][];
  /** The message's own epoch tag — derives the plane address for jump-to-context. */
  epoch: string | undefined;
  /** Ordering basis: created_at*1000 + ms tag. */
  ms: number;
  createdAt: number;
  /** Untrusted locator hint, if the entry carried one. */
  wrapHint?: string;
  /** Set when a proven Edit superseded the original's words. */
  edited?: { content: string; ms: number };
  /** The wire entry, verbatim — for republishing (re-wraps, omissions). */
  entry: PinEntry;
}

const HEX64 = /^[0-9a-f]{64}$/;

function tagValue(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1];
  return undefined;
}

function resolveMs(createdAt: number, tags: string[][]): number {
  const raw = tagValue(tags, "ms");
  const ms = raw !== undefined && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : 0;
  return createdAt * 1000 + (ms <= 999 ? ms : 0);
}

/**
 * Build a pin entry from an opened chat message. Requires the stream
 * conversation key of the Channel at the message's epoch — i.e. the pinner can
 * read what they pin. Returns undefined when the disclosure cannot be produced
 * (not an encrypted seal, or the key doesn't fit the payload).
 */
export function buildPinEntry(opened: OpenedEvent, convKey: Uint8Array): PinEntry | undefined {
  return buildPinEntryOrReason(opened, convKey).entry;
}

/** Why a message could not be pinned — each cause needs a different answer. */
export type PinBuildFailure = "no-seal" | "pending" | "not-encrypted" | "bad-payload" | "unverifiable";

/**
 * A row a client just sent carries a PLACEHOLDER seal — empty content, no
 * signature — so the message paints before the (possibly remote) signer
 * answers. It is truthy, so a plain presence check waves it through into
 * verification, where it fails as unreadable rather than as unfinished.
 */
export function isPlaceholderSeal(seal: NostrEvent | undefined): boolean {
  return Boolean(seal) && (!seal!.sig || !seal!.content);
}

/**
 * {@link buildPinEntry} with the reason attached. A pinner told "that message
 * is from an epoch you no longer hold" when the real cause is a missing seal
 * will retry forever, so the caller gets the distinction.
 */
export function buildPinEntryOrReason(
  opened: OpenedEvent,
  convKey: Uint8Array,
): { entry?: PinEntry; reason?: PinBuildFailure } {
  const seal = opened.seal;
  if (!seal) return { reason: "no-seal" };
  if (isPlaceholderSeal(seal)) return { reason: "pending" };
  if (seal.kind !== KIND_SEAL_ENCRYPTED) return { reason: "not-encrypted" };
  const keys = discloseKeysFor(seal.content, convKey);
  if (!keys) return { reason: "bad-payload" };
  // Deriving keys is not the same as being able to read: the expansion succeeds
  // under ANY conversation key, and a message written under an epoch we no
  // longer hold only fails later, at the MAC. Check it here so "you don't hold
  // these keys" and "this proof doesn't hold up" stay different answers — the
  // pinner can act on one of them.
  if (decryptWithDisclosedKeys(seal.content, keys) === undefined) return { reason: "bad-payload" };
  // Refuse to build an entry that would not verify — a pinner publishing a
  // broken proof burns list budget for nothing.
  const entry: PinEntry = { seal, keys: encodeMessageKeys(keys), wrap: opened.wrapId };
  return verifyPinEntry(entry, tagValue(opened.tags, "channel") ?? "") ? { entry } : { reason: "unverifiable" };
}

/**
 * The §7 verification, holding nothing but the pin and the list's Channel:
 * seal kind + signature → MAC → decrypt → rumor checks (author equality, chat
 * kind, channel binding) → recomputed id. Returns undefined on ANY failure;
 * a failed entry is dropped alone, its edition folds normally.
 */
export function verifyPinEntry(entry: PinEntry, channelIdHex: string): VerifiedPin | undefined {
  // The list's elements are unvalidated wire data: a curator can publish
  // `{"entries":[null]}` under both caps. Reaching `.seal` first would throw
  // inside the caller's render memo and take the channel view down for
  // everyone, permanently, until that head is replaced.
  if (!entry || typeof entry !== "object") return undefined;
  const seal = entry.seal;
  if (!seal || typeof seal !== "object") return undefined;
  if (seal.kind !== KIND_SEAL_ENCRYPTED) return undefined;
  let sigOk = false;
  try {
    sigOk = verifyEvent(seal);
  } catch {
    return undefined;
  }
  if (!sigOk) return undefined;

  const keys = decodeMessageKeys(entry.keys ?? "");
  if (!keys) return undefined;
  const plaintext = decryptWithDisclosedKeys(seal.content, keys);
  if (plaintext === undefined) return undefined;

  let rumor: NostrRumor;
  try {
    rumor = JSON.parse(plaintext) as NostrRumor;
  } catch {
    return undefined;
  }
  if (typeof rumor !== "object" || rumor === null) return undefined;
  // NIP-59's impersonation check: renderers display rumor fields, so a seal
  // honestly signed around a rumor claiming another author must fail.
  if (rumor.pubkey !== seal.pubkey) return undefined;
  if (rumor.kind !== KIND_MESSAGE && rumor.kind !== KIND_COMMENT) return undefined;
  if (!Array.isArray(rumor.tags)) return undefined;
  // The rumor names its Channel under the author's signature (CORD-01 Binding);
  // strict equality against the list's own Channel, absence failing — without
  // this, a private Channel's keyholder could pin its messages into a public
  // list, disclosing them Community-wide with proof.
  if (!HEX64.test(channelIdHex) || tagValue(rumor.tags, "channel") !== channelIdHex) return undefined;
  if (typeof rumor.content !== "string" || !Number.isSafeInteger(rumor.created_at)) return undefined;

  let rumorId: string;
  try {
    rumorId = getEventHash({
      kind: rumor.kind,
      content: rumor.content,
      tags: rumor.tags,
      created_at: rumor.created_at,
      pubkey: rumor.pubkey,
    });
  } catch {
    return undefined;
  }

  // The Edit bundle, if the entry carries one. A bad bundle drops the EDIT,
  // never the pin: the original is still proven, and refusing it outright would
  // hide a message because someone attached a bad correction.
  const edited = entry.edit ? verifyEditBundle(entry.edit, seal.pubkey, rumorId, channelIdHex) : undefined;

  return {
    rumorId,
    author: seal.pubkey,
    kind: rumor.kind,
    content: edited?.content ?? rumor.content,
    tags: rumor.tags,
    epoch: tagValue(rumor.tags, "epoch"),
    ms: resolveMs(rumor.created_at, rumor.tags),
    createdAt: rumor.created_at,
    wrapHint: typeof entry.wrap === "string" ? entry.wrap : undefined,
    edited,
    entry,
  };
}

/**
 * An Edit bundle proves the SAME author revised THIS message: the five steps of
 * {@link verifyPinEntry} plus the fold's own two rules — author equality (nobody
 * else may revise another member's words) and an `e` tag naming the original's
 * recomputed rumor id.
 */
function verifyEditBundle(
  bundle: { seal: NostrEvent; keys: string },
  originalAuthor: string,
  originalRumorId: string,
  channelIdHex: string,
): { content: string; ms: number } | undefined {
  const seal = bundle?.seal;
  if (!seal || typeof seal !== "object" || seal.kind !== KIND_SEAL_ENCRYPTED) return undefined;
  // Author equality is checkable before any crypto: a bundle sealed by anyone
  // but the original's author cannot revise it, whatever it decrypts to.
  if (seal.pubkey !== originalAuthor) return undefined;
  let sigOk = false;
  try {
    sigOk = verifyEvent(seal);
  } catch {
    return undefined;
  }
  if (!sigOk) return undefined;

  const keys = decodeMessageKeys(bundle.keys ?? "");
  if (!keys) return undefined;
  const plaintext = decryptWithDisclosedKeys(seal.content, keys);
  if (plaintext === undefined) return undefined;

  let rumor: NostrRumor;
  try {
    rumor = JSON.parse(plaintext) as NostrRumor;
  } catch {
    return undefined;
  }
  if (typeof rumor !== "object" || rumor === null) return undefined;
  if (rumor.pubkey !== seal.pubkey) return undefined;
  if (rumor.kind !== KIND_EDIT) return undefined;
  if (!Array.isArray(rumor.tags)) return undefined;
  // Step 4 binds the Edit to this Channel too — a reader must not be weaker
  // than the writer, which already enforces this via withProvenEdit.
  if (tagValue(rumor.tags, "channel") !== channelIdHex) return undefined;
  if (tagValue(rumor.tags, "e") !== originalRumorId) return undefined;
  if (typeof rumor.content !== "string" || !Number.isSafeInteger(rumor.created_at)) return undefined;
  return { content: rumor.content, ms: resolveMs(rumor.created_at, rumor.tags) };
}

// ── The list's two self-describing content forms ─────────────────────────────

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Serialize a pin list's `content` for a PUBLIC Channel (plaintext — the
 * plane's wrap is the gate). Throws on a cap violation: a writer must never
 * publish an edition every reader would read as empty.
 */
export function serializePublicPinList(entries: PinEntry[]): string {
  const content = JSON.stringify({ entries });
  assertCaps(entries.length, content);
  return content;
}

/**
 * Serialize for a PRIVATE Channel: the entries sealed under the Channel's
 * group conversation key at `epoch`. Both caps are checked on the final
 * carried bytes, the sealed envelope living INSIDE the byte cap.
 */
export function serializeSealedPinList(entries: PinEntry[], convKey: Uint8Array, epoch: bigint): string {
  if (entries.length > PIN_MAX_ENTRIES) throw new Error(`pin list exceeds ${PIN_MAX_ENTRIES} entries`);
  const sealed = nip44Encrypt(JSON.stringify({ entries }), convKey);
  const content = JSON.stringify({ epoch: epoch.toString(), sealed });
  assertCaps(entries.length, content);
  return content;
}

function assertCaps(count: number, content: string): void {
  if (count > PIN_MAX_ENTRIES) throw new Error(`pin list exceeds ${PIN_MAX_ENTRIES} entries`);
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > PIN_MAX_CONTENT_BYTES) throw new Error(`pin list content is ${bytes} bytes (cap ${PIN_MAX_CONTENT_BYTES})`);
}

/**
 * Read a pin list edition's `content` (§7 Limits): the byte cap judged on the
 * exact carried bytes by every reader; the entry cap by whoever can open the
 * form. A violating or unreadable-as-JSON edition reads as an EMPTY list —
 * never refused from the fold. A sealed form whose epoch key the reader lacks
 * returns `sealed: true` with no entries: darkness, not violation.
 */
export function readPinList(
  content: string,
  unsealKey: (epoch: bigint) => Uint8Array | undefined,
): { entries: PinEntry[]; sealed: boolean } {
  const EMPTY = { entries: [] as PinEntry[], sealed: false };
  if (typeof content !== "string") return EMPTY;
  if (new TextEncoder().encode(content).length > PIN_MAX_CONTENT_BYTES) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY;
  const obj = parsed as { entries?: unknown; epoch?: unknown; sealed?: unknown };

  if (Array.isArray(obj.entries)) {
    if (obj.entries.length > PIN_MAX_ENTRIES) return EMPTY;
    return { entries: obj.entries as PinEntry[], sealed: false };
  }

  if (typeof obj.epoch === "string" && DECIMAL.test(obj.epoch) && typeof obj.sealed === "string") {
    const key = unsealKey(BigInt(obj.epoch));
    if (!key) return { entries: [], sealed: true };
    let inner: unknown;
    try {
      inner = JSON.parse(nip44Decrypt(obj.sealed, key));
    } catch {
      return EMPTY;
    }
    const entries = (inner as { entries?: unknown })?.entries;
    if (!Array.isArray(entries)) return EMPTY;
    if (entries.length > PIN_MAX_ENTRIES) return EMPTY;
    return { entries: entries as PinEntry[], sealed: false };
  }

  return EMPTY;
}

// ── Deletion (§7): self-erasure outranks curation ────────────────────────────

/**
 * Whether a kind-5 kills this pin: matched by the RECOMPUTED rumor id against
 * the delete's `e` tags, honored only when the delete's author equals the
 * pin's proven author.
 */
export function pinKilledBy(pin: VerifiedPin, deleteEvent: { author: string; tags: string[][] }): boolean {
  if (deleteEvent.author !== pin.author) return false;
  for (const t of deleteEvent.tags) if (t[0] === "e" && t[1] === pin.rumorId) return true;
  return false;
}

/** Split verified pins into the living and those an author's delete killed. */
export function partitionDeletedPins(
  pins: VerifiedPin[],
  deletes: readonly { author: string; tags: string[][] }[],
): { alive: VerifiedPin[]; killed: VerifiedPin[] } {
  const alive: VerifiedPin[] = [];
  const killed: VerifiedPin[] = [];
  for (const pin of pins) {
    (deletes.some((d) => pinKilledBy(pin, d)) ? killed : alive).push(pin);
  }
  return { alive, killed };
}

/**
 * Attach the newest provable Edit to an entry (§7 Edits). Requires the Channel
 * conversation key of the Edit's own epoch — i.e. the curator can read it.
 * Returns the entry unchanged when the Edit cannot be proven, so a refresh
 * never downgrades a good pin into a broken one.
 */
export function withProvenEdit(entry: PinEntry, editOpened: OpenedEvent, convKey: Uint8Array): PinEntry {
  const seal = editOpened.seal;
  if (!seal || seal.kind !== KIND_SEAL_ENCRYPTED) return entry;
  const keys = discloseKeysFor(seal.content, convKey);
  if (!keys) return entry;
  const candidate: PinEntry = { ...entry, edit: { seal, keys: encodeMessageKeys(keys) } };
  // Only keep it if it actually verifies against this entry — the same gate a
  // reader will apply, run before it costs list budget.
  return verifyPinEntry(candidate, tagValue(editOpened.tags, "channel") ?? "")?.edited ? candidate : entry;
}

/**
 * Whether a write this client made still outranks what the control fold shows,
 * and so must be the base for the next one.
 *
 * The list is replace-entire and the fold is a relay round trip behind every
 * write. Two actions in quick succession would each build from the pre-write
 * list, so the second erases the first's entry and claims a version already
 * taken. A client that publishes edition N keeps N as its truth until it sees
 * a fold at N or later — including a LATER one, since a version beyond ours is
 * someone else's write and theirs is the list that now exists.
 */
export function unconfirmedWrite<T>(
  mine: { version: bigint; held: T } | undefined,
  folded: { version: bigint } | undefined,
): T | undefined {
  if (!mine) return undefined;
  if (folded && folded.version >= mine.version) return undefined;
  return mine.held;
}
