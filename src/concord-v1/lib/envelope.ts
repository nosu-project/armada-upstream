/**
 * Concord message envelope — ported from Vector's `community/envelope.rs`.
 *
 * A Concord message is an inner Nostr event signed by the author's real key (the
 * authorship proof), NIP-44-v2-encrypted under the shared channel key, and
 * wrapped in an ephemeral-signed outer event tagged with the per-epoch
 * pseudonym. Single NIP-44 pass, O(1) broadcast.
 *
 * `openMessage` enforces the binding triad: inner Schnorr signature valid, and
 * inner kind/channel/epoch equal to the outer kind and to the specific
 * channel/epoch whose key decrypted the payload (strict equality, never a
 * membership test) — defeating insider replay/splice across type/channel/epoch.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/concord-v1/lib/cipher";
import { channelPseudonym } from "@/concord-v1/lib/derive";
import type { NostrRumor } from "@/lib/nostrRumor";
import {
  KIND_COMMUNITY_DELETE,
  KIND_COMMUNITY_EDIT,
  KIND_COMMUNITY_KICK,
  KIND_COMMUNITY_MESSAGE,
  KIND_COMMUNITY_PRESENCE,
  KIND_COMMUNITY_TYPING,
  KIND_COMMUNITY_WEBXDC,
} from "@/concord-v1/lib/kinds";

const PROTOCOL_VERSION = "1";
const TAG_VERSION = "v";
const TAG_CHANNEL = "channel";
const TAG_EPOCH = "epoch";
const TAG_MS = "ms";

export class EnvelopeError extends Error {
  constructor(
    public code:
      | "sign"
      | "encrypt"
      | "decrypt"
      | "inner-parse"
      | "bad-version"
      | "kind-mismatch"
      | "channel-mismatch"
      | "epoch-mismatch"
      | "bad-signature"
      | "missing-tag"
      | "duplicate-tag"
      | "no-held-epoch",
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** A successfully opened and fully-verified Concord message. */
export interface OpenedMessage {
  /** Inner event id — the message id / dedup / display key. */
  messageId: string;
  /** Verified real author (hex pubkey). */
  author: string;
  content: string;
  channelId: Uint8Array;
  epoch: bigint;
  /** Ordering timestamp (epoch ms): `created_at*1000 + ms`. */
  ms: number;
  createdAt: number;
  kind: number;
  /** The outer wire event id (the relay-addressable carrier; the transport dedup key). */
  wrapperId: string;
  /** The verified inner event's raw tags. */
  tags: string[][];
}

const APPEND_PLANE_KINDS = new Set<number>([
  KIND_COMMUNITY_MESSAGE,
  KIND_COMMUNITY_EDIT, // 3302; 3301 reaction sits between, included below
  3301,
  KIND_COMMUNITY_DELETE,
  KIND_COMMUNITY_PRESENCE,
  KIND_COMMUNITY_KICK,
  KIND_COMMUNITY_WEBXDC,
  KIND_COMMUNITY_TYPING,
]);

/**
 * Build the inner authorship-proof event UNSIGNED. `ms` is the full send time in
 * epoch-milliseconds: `created_at` carries the seconds, the `ms` tag carries the
 * sub-second offset (0..999), reconstructed on open as `created_at*1000 + ms`.
 */
export function buildInnerEvent(opts: {
  channelId: Uint8Array;
  epoch: bigint;
  kind?: number;
  content: string;
  ms: number;
  /** Reply/react/edit target inner id. */
  reference?: string;
  /** Extra inner tags appended verbatim (e.g. NIP-92 imeta). */
  extraTags?: string[][];
}): EventTemplate {
  const kind = opts.kind ?? KIND_COMMUNITY_MESSAGE;
  const createdSecs = Math.floor(opts.ms / 1000);
  const msOffset = opts.ms % 1000;
  const tags: string[][] = [
    [TAG_CHANNEL, bytesToHex(opts.channelId)],
    [TAG_EPOCH, opts.epoch.toString()],
    [TAG_MS, msOffset.toString()],
  ];
  if (opts.reference) tags.push(["e", opts.reference, "", "reply"]);
  if (opts.extraTags) tags.push(...opts.extraTags);
  return { kind, content: opts.content, tags, created_at: createdSecs };
}

/** First value of the first tag named `name`. */
function findTag(ev: NostrRumor, name: string): string | undefined {
  const t = ev.tags.find((t) => t[0] === name);
  return t?.[1];
}

/** Value of a tag required to appear AT MOST ONCE (binding tags must be unambiguous). */
function uniqueTag(ev: NostrRumor, name: string): string | undefined {
  let found: string | undefined;
  for (const t of ev.tags) {
    if (t[0] === name) {
      if (found !== undefined) {
        throw new EnvelopeError("duplicate-tag", `duplicate inner tag: ${name}`);
      }
      found = t[1];
    }
  }
  return found;
}

/**
 * Seal an already-signed inner authorship event into the outer wire event. The
 * inner may have been signed by local keys or a remote bunker — signer-agnostic.
 * Re-checks the binding (kind/channel/epoch) so a caller can never seal an inner
 * the receiver would reject.
 */
export function sealWithSignedInner(
  inner: NostrEvent,
  channelKey: Uint8Array,
  channelId: Uint8Array,
  epoch: bigint,
  ephemeralSk?: Uint8Array,
): NostrEvent {
  const innerKind = inner.kind;
  if (!APPEND_PLANE_KINDS.has(innerKind)) {
    throw new EnvelopeError("kind-mismatch", `inner kind ${innerKind} is not an append-plane kind`);
  }
  if (uniqueTag(inner, TAG_CHANNEL) !== bytesToHex(channelId)) {
    throw new EnvelopeError("channel-mismatch", "channel-binding mismatch (splice)");
  }
  if (uniqueTag(inner, TAG_EPOCH) !== epoch.toString()) {
    throw new EnvelopeError("epoch-mismatch", "epoch-binding mismatch (splice)");
  }

  const contentB64 = cipherSeal(channelKey, JSON.stringify(inner));
  const pseudonym = bytesToHex(channelPseudonym(channelKey, channelId, epoch));
  const sk = ephemeralSk ?? generateSecretKey();
  return finalizeEvent(
    {
      kind: innerKind,
      content: contentB64,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["z", pseudonym],
        [TAG_VERSION, PROTOCOL_VERSION],
      ],
    },
    sk,
  );
}

/**
 * Seal a plaintext message with local author keys. The outer event is signed by a
 * fresh one-time key (no persistent author↔channel linkage on the wire).
 */
export function sealMessage(opts: {
  authorSk: Uint8Array;
  channelKey: Uint8Array;
  channelId: Uint8Array;
  epoch: bigint;
  content: string;
  ms: number;
  kind?: number;
  reference?: string;
  extraTags?: string[][];
  ephemeralSk?: Uint8Array;
}): NostrEvent {
  const template = buildInnerEvent(opts);
  const inner = finalizeEvent(template, opts.authorSk);
  return sealWithSignedInner(inner, opts.channelKey, opts.channelId, opts.epoch, opts.ephemeralSk);
}

/** Reconstruct the full ms timestamp (`created_at*1000 + offset`, clamped to 0..999). */
function resolveMs(createdSecs: number, msTag: string | undefined): number {
  let offset = 0;
  if (msTag !== undefined) {
    const n = Number(msTag);
    if (Number.isInteger(n) && n >= 0 && n <= 999) offset = n;
  }
  return createdSecs * 1000 + offset;
}

/** Open and fully verify an outer wire event under a specific channel/epoch key. */
export function openMessage(
  outer: NostrRumor,
  channelKey: Uint8Array,
  channelId: Uint8Array,
  epoch: bigint,
): OpenedMessage {
  const version = findTag(outer, TAG_VERSION);
  if (version !== PROTOCOL_VERSION) {
    throw new EnvelopeError("bad-version", `unsupported protocol version: ${version}`);
  }

  let json: string;
  try {
    json = cipherOpen(channelKey, outer.content);
  } catch (e) {
    throw new EnvelopeError("decrypt", `decrypt: ${e instanceof Error ? e.message : e}`);
  }
  let inner: NostrEvent;
  try {
    inner = JSON.parse(json) as NostrEvent;
  } catch (e) {
    throw new EnvelopeError("inner-parse", `inner parse: ${e instanceof Error ? e.message : e}`);
  }

  if (!verifyEvent(inner)) {
    throw new EnvelopeError("bad-signature", "inner author signature invalid");
  }
  if (inner.kind !== outer.kind) {
    throw new EnvelopeError("kind-mismatch", `kind mismatch: outer ${outer.kind} != inner ${inner.kind}`);
  }
  const innerChannel = uniqueTag(inner, TAG_CHANNEL);
  if (innerChannel === undefined) throw new EnvelopeError("missing-tag", "missing inner tag: channel");
  if (innerChannel !== bytesToHex(channelId)) {
    throw new EnvelopeError("channel-mismatch", "channel-binding mismatch (splice)");
  }
  const innerEpoch = uniqueTag(inner, TAG_EPOCH);
  if (innerEpoch === undefined) throw new EnvelopeError("missing-tag", "missing inner tag: epoch");
  if (innerEpoch !== epoch.toString()) {
    throw new EnvelopeError("epoch-mismatch", "epoch-binding mismatch (splice)");
  }

  return {
    messageId: inner.id,
    author: inner.pubkey,
    content: inner.content,
    channelId,
    epoch,
    ms: resolveMs(inner.created_at, uniqueTag(inner, TAG_MS)),
    createdAt: inner.created_at,
    kind: inner.kind,
    wrapperId: outer.id,
    tags: inner.tags,
  };
}

/**
 * Open an outer wire event when the member may hold MULTIPLE epoch keys: select
 * the decryption key by matching the outer's `z` pseudonym against each held
 * epoch's recomputed pseudonym, then open under that exact epoch.
 */
export function openMessageMulti(
  outer: NostrRumor,
  channelId: Uint8Array,
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>,
): OpenedMessage {
  const z = findTag(outer, "z");
  if (z === undefined) throw new EnvelopeError("missing-tag", "missing outer tag: z");
  for (const { epoch, key } of epochKeys) {
    if (bytesToHex(channelPseudonym(key, channelId, epoch)) === z) {
      return openMessage(outer, key, channelId, epoch);
    }
  }
  throw new EnvelopeError("no-held-epoch", "no held epoch key for this pseudonym");
}

/**
 * Build an {@link OpenedMessage} directly from a locally-signed inner event and
 * the sealed outer it was wrapped in — without a decrypt round-trip. Used for
 * optimistic rendering on the send path: we already hold the verified inner
 * (we just signed it) and the sealed outer (we just produced it), so this is
 * exactly what `openMessage` would return once the relay echoes the outer back,
 * and it reconciles by `messageId` (the inner id) on the next refetch.
 */
export function openedFromSealed(
  inner: NostrEvent,
  outer: NostrEvent,
  channelId: Uint8Array,
  epoch: bigint,
): OpenedMessage {
  return {
    messageId: inner.id,
    author: inner.pubkey,
    content: inner.content,
    channelId,
    epoch,
    ms: resolveMs(inner.created_at, uniqueTag(inner, TAG_MS)),
    createdAt: inner.created_at,
    kind: inner.kind,
    wrapperId: outer.id,
    tags: inner.tags,
  };
}

/**
 * Open a Concord message from an inner event that was ALREADY decrypted off the
 * WebView (e.g. by the Android background service, which holds the channel key
 * and decrypts the sealed outer to render its notification). The native side
 * verifies only the NIP-44 HMAC + channel/epoch binding, NOT the inner Schnorr
 * signature — so we re-establish full trust here before rendering:
 *
 *   1. select the epoch key whose pseudonym matches the outer `z` (so the inner
 *      is bound to a channel/epoch we actually hold a key for);
 *   2. verify the inner author's Schnorr signature (defeats a channel-key holder
 *      forging another member's `pubkey` — native can't catch this);
 *   3. enforce the same kind/channel/epoch binding triad as {@link openMessage}.
 *
 * Returns the {@link OpenedMessage} ready to fold into the timeline — with the
 * exact same shape and `messageId` (inner id) the relay-fetched + decrypted path
 * produces, so it dedupes/reconciles cleanly when the outer is later seen.
 *
 * Throws {@link EnvelopeError} on any failure (no held epoch, bad signature,
 * binding mismatch), so a malformed/forged native feed is simply dropped.
 */
export function openVerifiedInner(
  inner: NostrEvent,
  z: string,
  outerId: string,
  channelId: Uint8Array,
  epochKeys: Array<{ epoch: bigint; key: Uint8Array }>,
): OpenedMessage {
  // 1. Bind to a held epoch via the outer pseudonym.
  let epoch: bigint | undefined;
  for (const ek of epochKeys) {
    if (bytesToHex(channelPseudonym(ek.key, channelId, ek.epoch)) === z) {
      epoch = ek.epoch;
      break;
    }
  }
  if (epoch === undefined) {
    throw new EnvelopeError("no-held-epoch", "no held epoch key for this pseudonym");
  }

  // 2. Full author authentication — the native side did NOT do this.
  if (!verifyEvent(inner)) {
    throw new EnvelopeError("bad-signature", "inner author signature invalid");
  }

  // 3. Binding triad (channel + epoch), matching openMessage's checks.
  const innerChannel = uniqueTag(inner, TAG_CHANNEL);
  if (innerChannel === undefined) throw new EnvelopeError("missing-tag", "missing inner tag: channel");
  if (innerChannel !== bytesToHex(channelId)) {
    throw new EnvelopeError("channel-mismatch", "channel-binding mismatch (splice)");
  }
  const innerEpoch = uniqueTag(inner, TAG_EPOCH);
  if (innerEpoch === undefined) throw new EnvelopeError("missing-tag", "missing inner tag: epoch");
  if (innerEpoch !== epoch.toString()) {
    throw new EnvelopeError("epoch-mismatch", "epoch-binding mismatch (splice)");
  }

  return {
    messageId: inner.id,
    author: inner.pubkey,
    content: inner.content,
    channelId,
    epoch,
    ms: resolveMs(inner.created_at, uniqueTag(inner, TAG_MS)),
    createdAt: inner.created_at,
    kind: inner.kind,
    wrapperId: outerId,
    tags: inner.tags,
  };
}

export { getPublicKey };