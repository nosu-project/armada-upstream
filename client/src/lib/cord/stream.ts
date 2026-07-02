/**
 * CORD-01 Private Stream envelope — the experimental Concord wire format.
 *
 * Every CORD wire event is a kind-1059 "gift wrap" that only *looks* like a
 * regular NIP-59 wrap. Unlike NIP-59 it has a FIXED author (the derived group
 * signing key — the Stream address clients query with `authors`) and an
 * EPHEMERAL `p` tag (a random throwaway pubkey, so the event blends into
 * ordinary gift-wrap traffic), and its `created_at` is not tweaked. Inside:
 *
 *   rumor        = UNSIGNED Nostr event (has an `id`, no `sig`) — the action
 *   seal (20013) = content = nip44(conv, rumor JSON), SIGNED by the author's
 *                  real identity key — the authorship proof
 *   wrap (1059)  = content = nip44(conv, seal JSON), signed by the group key
 *
 * CORD seals are kind 20013, NOT the NIP-59 kind 13: clients of unrelated
 * NIP-59 flows unwrap kind-13 seals leniently (nostr-protocol/nips#2398), and
 * private streams are queried separately from regular gift wraps anyway, so a
 * distinct kind creates no compatibility issue.
 *
 * `conv` is the group key's NIP-44 self-ECDH conversation key (CORD-02 A.2) —
 * one derived keypair is address, wrap signer, and encryptor at once. Only a
 * holder of the plane's secret can compute it, so an outsider can neither read
 * nor spam a member's `authors` filter.
 *
 * OpenedMessage kinds are NORMALIZED to the v1 constants (9→3300, 7→3301,
 * 5→3305) so every fold/UI layer above the envelope is protocol-agnostic.
 */

import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent, UnsignedEvent } from "nostr-tools/pure";

import { open as cipherOpen, seal as cipherSeal } from "@/lib/concord/cipher";
import { EnvelopeError, type OpenedMessage } from "@/lib/concord/envelope";
import {
  KIND_COMMUNITY_DELETE,
  KIND_COMMUNITY_MESSAGE,
  KIND_COMMUNITY_REACTION,
  KIND_GIFT_WRAP,
} from "@/lib/concord/kinds";
import type { GroupKey } from "@/lib/cord/derive";

import { bytesToHex } from "@noble/hashes/utils.js";

const KIND_SEAL = 20013;
const TAG_CHANNEL = "channel";
const TAG_EPOCH = "epoch";
const TAG_MS = "ms";

/** CORD reuses standard rumor kinds where a clean fit exists (CORD-01/V2 drafts). */
const RUMOR_KIND_MESSAGE = 9; // NIP-29 chat message
const RUMOR_KIND_REACTION = 7; // NIP-25 reaction
const RUMOR_KIND_DELETE = 5; // NIP-09 deletion

/** Map a logical (v1-constant) kind to the CORD rumor kind. Identity elsewhere. */
export function rumorKindOf(logicalKind: number): number {
  if (logicalKind === KIND_COMMUNITY_MESSAGE) return RUMOR_KIND_MESSAGE;
  if (logicalKind === KIND_COMMUNITY_REACTION) return RUMOR_KIND_REACTION;
  if (logicalKind === KIND_COMMUNITY_DELETE) return RUMOR_KIND_DELETE;
  return logicalKind;
}

/** Map a CORD rumor kind back to the logical (v1-constant) kind. */
export function logicalKindOf(rumorKind: number): number {
  if (rumorKind === RUMOR_KIND_MESSAGE) return KIND_COMMUNITY_MESSAGE;
  if (rumorKind === RUMOR_KIND_REACTION) return KIND_COMMUNITY_REACTION;
  if (rumorKind === RUMOR_KIND_DELETE) return KIND_COMMUNITY_DELETE;
  return rumorKind;
}

/** A CORD rumor: an unsigned event WITH its id (NIP-59 rumor shape). */
export type CordRumor = UnsignedEvent & { id: string };

/** Finalize an unsigned rumor template for `author`: attach pubkey + id. */
export function finalizeRumor(template: EventTemplate, authorPubkey: string): CordRumor {
  const unsigned: UnsignedEvent = { ...template, pubkey: authorPubkey };
  return { ...unsigned, id: getEventHash(unsigned) };
}

/**
 * Build an append-plane rumor template (channel/epoch/ms binding tags + reply
 * reference + extra tags), taking the LOGICAL kind (v1 constants). Same tag
 * layout as v1's inner event, carried over per the gap-fill convention.
 */
export function buildCordRumorTemplate(opts: {
  channelId: Uint8Array;
  epoch: bigint;
  kind?: number;
  content: string;
  ms: number;
  reference?: string;
  extraTags?: string[][];
}): EventTemplate {
  const kind = rumorKindOf(opts.kind ?? KIND_COMMUNITY_MESSAGE);
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

/**
 * Build the kind-20013 seal TEMPLATE for a rumor: its content is the rumor JSON
 * encrypted under the group conversation key. Sign it with the author's real
 * identity signer (local keys or a bunker — it's an ordinary event), then feed
 * the signed seal to {@link wrapSeal}.
 */
export function buildSealTemplate(rumor: CordRumor, group: GroupKey): EventTemplate {
  return {
    kind: KIND_SEAL,
    content: cipherSeal(group.conv, JSON.stringify(rumor)),
    tags: [],
    created_at: Math.floor(Date.now() / 1000),
  };
}

/**
 * Wrap a signed seal into the outer kind-1059 Stream event: signed by the
 * derived group key (its pubkey IS the relay address), `p`-tagged with a random
 * ephemeral pubkey so it blends into ordinary gift-wrap traffic (CORD-01).
 */
export function wrapSeal(seal: NostrEvent, group: GroupKey): NostrEvent {
  if (seal.kind !== KIND_SEAL) throw new EnvelopeError("kind-mismatch", "seal must be kind 20013");
  const ephemeralP = getPublicKey(generateSecretKey());
  const template: EventTemplate = {
    kind: KIND_GIFT_WRAP,
    content: cipherSeal(group.conv, JSON.stringify(seal)),
    tags: [["p", ephemeralP]],
    created_at: Math.floor(Date.now() / 1000),
  };
  // finalizeEvent derives the pubkey from the group sk — group.pk by construction.
  return finalizeEvent(template, group.sk);
}

/** A fully-opened CORD stream event: the verified rumor + its proven author. */
export interface OpenedStream {
  rumor: CordRumor;
  /** The seal signer == rumor pubkey (hex): the proven real author. */
  author: string;
}

/**
 * Open one CORD stream event under a specific group key. Verifies, in order:
 * the wrap signer matches the group address, the wrap decrypts (MAC), the seal
 * is kind 20013 with a valid Schnorr signature, the seal decrypts, the rumor's
 * `pubkey` equals the seal signer (anti-impersonation), and the rumor `id` is
 * the true event hash. Throws {@link EnvelopeError} on any failure.
 */
export function openCordStream(outer: NostrEvent, group: GroupKey): OpenedStream {
  if (outer.kind !== KIND_GIFT_WRAP) {
    throw new EnvelopeError("kind-mismatch", `not a stream wrap (kind ${outer.kind})`);
  }
  if (outer.pubkey !== group.pk) {
    throw new EnvelopeError("no-held-epoch", "wrap signer is not this group address");
  }

  let seal: NostrEvent;
  try {
    seal = JSON.parse(cipherOpen(group.conv, outer.content)) as NostrEvent;
  } catch (e) {
    throw new EnvelopeError("decrypt", `wrap decrypt: ${e instanceof Error ? e.message : e}`);
  }
  if (!seal || seal.kind !== KIND_SEAL) {
    throw new EnvelopeError("inner-parse", "wrap content is not a kind-20013 seal");
  }
  if (!verifyEvent(seal)) {
    throw new EnvelopeError("bad-signature", "seal signature invalid");
  }

  let rumor: CordRumor;
  try {
    rumor = JSON.parse(cipherOpen(group.conv, seal.content)) as CordRumor;
  } catch (e) {
    throw new EnvelopeError("decrypt", `seal decrypt: ${e instanceof Error ? e.message : e}`);
  }
  if (!rumor || typeof rumor !== "object") {
    throw new EnvelopeError("inner-parse", "seal content is not a rumor");
  }
  if (rumor.pubkey !== seal.pubkey) {
    throw new EnvelopeError("bad-signature", "rumor author does not match seal signer");
  }
  const { id: claimed, ...rest } = rumor;
  if (getEventHash(rest as UnsignedEvent) !== claimed) {
    throw new EnvelopeError("bad-signature", "rumor id does not match its content");
  }

  return { rumor, author: seal.pubkey };
}

/** Value of a tag required to appear AT MOST ONCE (binding tags must be unambiguous). */
function uniqueTag(tags: string[][], name: string): string | undefined {
  let found: string | undefined;
  for (const t of tags) {
    if (t[0] === name) {
      if (found !== undefined) {
        throw new EnvelopeError("duplicate-tag", `duplicate rumor tag: ${name}`);
      }
      found = t[1];
    }
  }
  return found;
}

function resolveMs(createdSecs: number, msTag: string | undefined): number {
  let offset = 0;
  if (msTag !== undefined) {
    const n = Number(msTag);
    if (Number.isInteger(n) && n >= 0 && n <= 999) offset = n;
  }
  return createdSecs * 1000 + offset;
}

/** One held epoch's group key for a channel plane. */
export interface EpochGroup {
  epoch: bigint;
  group: GroupKey;
}

/**
 * Open an append-plane stream event as a channel message, enforcing the CORD
 * binding triad: wrap signer == a held epoch's group address (selects the
 * epoch), seal signer == rumor author, and the rumor's `channel`/`epoch` tags
 * strict-equal the coordinate that decrypted it. Returns an OpenedMessage with
 * the kind NORMALIZED to the v1 constants.
 */
export function openCordChannelMessage(
  outer: NostrEvent,
  channelId: Uint8Array,
  epochGroups: EpochGroup[],
): OpenedMessage {
  const hit = epochGroups.find((eg) => eg.group.pk === outer.pubkey);
  if (!hit) throw new EnvelopeError("no-held-epoch", "no held epoch group for this address");

  const { rumor, author } = openCordStream(outer, hit.group);

  const innerChannel = uniqueTag(rumor.tags, TAG_CHANNEL);
  if (innerChannel === undefined) throw new EnvelopeError("missing-tag", "missing rumor tag: channel");
  if (innerChannel !== bytesToHex(channelId)) {
    throw new EnvelopeError("channel-mismatch", "channel-binding mismatch (splice)");
  }
  const innerEpoch = uniqueTag(rumor.tags, TAG_EPOCH);
  if (innerEpoch === undefined) throw new EnvelopeError("missing-tag", "missing rumor tag: epoch");
  if (innerEpoch !== hit.epoch.toString()) {
    throw new EnvelopeError("epoch-mismatch", "epoch-binding mismatch (splice)");
  }

  return {
    messageId: rumor.id,
    author,
    content: rumor.content,
    channelId,
    epoch: hit.epoch,
    ms: resolveMs(rumor.created_at, uniqueTag(rumor.tags, TAG_MS)),
    createdAt: rumor.created_at,
    kind: logicalKindOf(rumor.kind),
    wrapperId: outer.id,
    tags: rumor.tags,
  };
}

/** Build the optimistic OpenedMessage for a just-sent rumor (no decrypt round-trip). */
export function openedFromCordRumor(
  rumor: CordRumor,
  outer: NostrEvent,
  channelId: Uint8Array,
  epoch: bigint,
): OpenedMessage {
  return {
    messageId: rumor.id,
    author: rumor.pubkey,
    content: rumor.content,
    channelId,
    epoch,
    ms: resolveMs(rumor.created_at, uniqueTag(rumor.tags, TAG_MS)),
    createdAt: rumor.created_at,
    kind: logicalKindOf(rumor.kind),
    wrapperId: outer.id,
    tags: rumor.tags,
  };
}

// ── Decode-once batch (mirrors lib/concord/decodeCache.ts for CORD wraps) ────

type DecodeResult = OpenedMessage | undefined;
const memo = new Map<string, DecodeResult>();

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** Open one CORD wrap, memoized by the wrap id (decrypt + verify once per session). */
export function openCordMemoized(
  outer: NostrEvent,
  channelId: Uint8Array,
  epochGroups: EpochGroup[],
): DecodeResult {
  const cached = memo.get(outer.id);
  if (cached !== undefined || memo.has(outer.id)) return cached;
  let opened: DecodeResult;
  try {
    opened = openCordChannelMessage(outer, channelId, epochGroups);
  } catch {
    opened = undefined; // not ours / bad-sig / no-held-epoch
  }
  memo.set(outer.id, opened);
  return opened;
}

/** Drop remembered failures so a caught-up rekey can retry `no-held-epoch` skips. */
export function forgetCordSkips(): void {
  for (const [id, result] of memo) {
    if (result === undefined) memo.delete(id);
  }
}

/** Open a batch of CORD wraps, chunked + yielding (see decodeCache.ts). */
export async function openCordBatch(
  events: NostrEvent[],
  channelId: Uint8Array,
  epochGroups: EpochGroup[],
  opts?: { signal?: AbortSignal; chunkSize?: number },
): Promise<OpenedMessage[]> {
  const chunkSize = opts?.chunkSize ?? 64;
  const out: OpenedMessage[] = [];
  for (let i = 0; i < events.length; i++) {
    if (opts?.signal?.aborted) break;
    const opened = openCordMemoized(events[i], channelId, epochGroups);
    if (opened) out.push(opened);
    if ((i + 1) % chunkSize === 0) await yieldToEventLoop();
  }
  return out;
}
