/**
 * DM voice calls — the CORD-07 blind-broker path applied to a 1:1 NIP-17
 * conversation.
 *
 * A DM call used to ride a relay's NIP-29 LiveKit token endpoint
 * (`/.well-known/nip29/livekit-dm/…`), coupling 1:1 calls to relay-hosted
 * infrastructure the default deployment no longer serves. It now works like a
 * Concord call, with the NIP-17 envelope standing in for the channel's key
 * distribution:
 *
 *   - The CALLER mints a fresh random 32-byte call secret. From it both sides
 *     derive the same CORD-07 sub-keys ({@link dmCallKeys}): `room` (its pk is
 *     the SFU room name, its sk signs the blind broker's token grant) and
 *     `mediaKey` (the E2EE frame-key material). The broker authorizes by
 *     key-possession proof and learns nothing about who is calling whom.
 *   - The secret reaches the callee inside a kind-23314 rumor, sealed and
 *     gift-wrapped like any NIP-17 message — the invite IS the ring signal,
 *     and only the two participants ever hold the room keys.
 *   - Media is end-to-end encrypted under ONE shared per-call key (LiveKit
 *     shared-key E2EE). Concord derives per-sender keys because many members
 *     would otherwise share an AEAD nonce domain; a 1:1 call has two senders
 *     and a fresh random key per call, where the shared-key profile is sound —
 *     and it needs no in-band identity exchange, which a DM call has no
 *     presence plane to carry.
 *
 * Phases (the rumor's content): "offer" (carries the secret + a broker
 * rendezvous hint), "answer" (callee accepted — also how the callee's OTHER
 * devices learn to stop ringing), "decline", and "end" (cancel-while-ringing
 * and hangup alike). All ride EPHEMERAL kind-21059 wraps (see
 * `KIND_DM_CALL`'s note in protocol.ts): relays broadcast and store nothing,
 * so no at-rest record of a call ever exists. The Android relay service holds
 * live sockets and rings with the app dead; the rumor's REAL `created_at`
 * bounds ringing ({@link DM_CALL_RING_MS}).
 */

import { sha256 } from "@noble/hashes/sha2.js";

import {
  bytesToHex,
  hex32,
  random32,
  voiceGroupKey,
  voiceMediaKey,
  type GroupKey,
} from "@/concord/lib/derive";
import { canonicalOrigin } from "@/concord/lib/voice";
import { KIND_DM_CALL, type OpenedDm } from "@/lib/nip17/protocol";

/** How long an offer rings before it counts as missed (both sides use this). */
export const DM_CALL_RING_MS = 45_000;

/**
 * The fixed 32-byte id slot for the CORD-07 derivations. A DM call has no
 * channel id; the per-call SECRET is what makes each call's keys unique, so
 * this constant only namespaces the derivation away from every Concord use.
 */
const DM_CALL_ID = sha256(new TextEncoder().encode("armada/dm-call"));

export interface DmCallKeys {
  /** The SFU room keypair: pk is the room name, sk signs token grants. */
  room: GroupKey;
  /** Raw 32-byte E2EE frame-key material (the shared per-call media key). */
  mediaKey: Uint8Array;
}

/** Derive the call's room + media keys from the shared per-call secret. */
export function dmCallKeys(secretHex: string): DmCallKeys {
  const secret = hex32(secretHex);
  return {
    room: voiceGroupKey(secret, DM_CALL_ID, 0),
    mediaKey: voiceMediaKey(secret, DM_CALL_ID, 0),
  };
}

/** Mint a fresh call: a random secret and the room name it derives. */
export function mintDmCall(): { secretHex: string; callId: string } {
  const secretHex = bytesToHex(random32());
  return { secretHex, callId: dmCallKeys(secretHex).room.pk };
}

export type DmCallPhase = "offer" | "answer" | "decline" | "end";

/** A verified, parsed call signal as opened from a DM gift wrap. */
export interface DmCallSignal {
  phase: DmCallPhase;
  /** The SFU room name (the call's stable id) — `dmCallKeys(secret).room.pk`. */
  callId: string;
  /** The seal-verified author of the signal. */
  author: string;
  /** The 1:1 counterpart from the viewer's perspective. */
  peer: string;
  /** The rumor's real timestamp, ms. */
  createdAtMs: number;
  rumorId: string;
  /** Offer only: the per-call secret both sides derive keys from. */
  secretHex?: string;
  /** Offer only: the canonicalized https broker origin hosting the call. */
  broker?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Tags for a call rumor: the peer `p` (the conversation, as every DM rumor),
 * the `call` binding, and — offers only — the secret + broker hint. No
 * NIP-40 expiration: the envelope is ephemeral, so there is nothing at rest
 * to expire, and freshness is the rumor's own real `created_at`.
 */
export function dmCallTags(
  peer: string,
  callId: string,
  opts?: { secretHex?: string; broker?: string },
): string[][] {
  const tags: string[][] = [
    ["p", peer],
    ["call", callId],
  ];
  if (opts?.secretHex) tags.push(["secret", opts.secretHex]);
  if (opts?.broker) tags.push(["broker", opts.broker]);
  return tags;
}

/**
 * Parse an opened DM rumor into a call signal, or null when it isn't one (or
 * is malformed). 1:1 only — a group thread has no pairwise call. An offer's
 * secret is VERIFIED against its claimed call id (the room name is a pure
 * function of the secret), so a signal can never seat a listener in a room
 * whose keys don't match what the tag claims; an offer without a usable
 * broker hint is refused too, since there is nothing to join.
 */
export function parseDmCall(opened: OpenedDm): DmCallSignal | null {
  if (opened.kind !== KIND_DM_CALL) return null;
  const phase = opened.content;
  if (phase !== "offer" && phase !== "answer" && phase !== "decline" && phase !== "end") return null;
  if (opened.peers.length !== 1) return null;
  // For a received signal the author IS the counterpart; for an own copy the
  // `p` tag names them. (Note to Self yields author === peer === self, which
  // the provider's own-author branch already ignores.)
  const peer = opened.peers[0];
  if (!HEX64.test(peer)) return null;
  const tag = (name: string) => opened.tags.find((t) => t[0] === name)?.[1];
  const callId = tag("call");
  if (typeof callId !== "string" || !HEX64.test(callId)) return null;

  let secretHex: string | undefined;
  let broker: string | undefined;
  if (phase === "offer") {
    const rawSecret = tag("secret");
    if (typeof rawSecret !== "string" || !HEX64.test(rawSecret)) return null;
    try {
      if (dmCallKeys(rawSecret).room.pk !== callId) return null;
    } catch {
      return null;
    }
    secretHex = rawSecret;
    const rawBroker = tag("broker");
    broker = typeof rawBroker === "string" && rawBroker.length <= 512
      ? canonicalOrigin(rawBroker) ?? undefined
      : undefined;
    if (!broker) return null;
  }

  return {
    phase,
    callId,
    author: opened.author,
    peer,
    createdAtMs: opened.createdAt * 1000,
    rumorId: opened.rumorId,
    secretHex,
    broker,
  };
}

/** Whether an offer is still inside its ring window (with future-skew guard). */
export function isDmOfferFresh(signal: DmCallSignal, nowMs = Date.now()): boolean {
  if (signal.phase !== "offer") return false;
  if (signal.createdAtMs > nowMs + 60_000) return false;
  return nowMs - signal.createdAtMs <= DM_CALL_RING_MS;
}

// ── The signal bus ───────────────────────────────────────────────────────────
//
// Call rumors are never stored, so the DM ingest paths (inbox sync, live wrap
// drain, backfill) hand them here at open time and the mounted call layer
// (DmCallProvider) reacts. Module-level rather than React state because the
// deliverers are plain async functions in useDm17.ts.

type DmCallListener = (signal: DmCallSignal) => void;

const listeners = new Set<DmCallListener>();
/** Rumor ids already dispatched — several ingest paths can open one wrap. */
const seenRumorIds = new Set<string>();

/** Subscribe to parsed call signals. Returns an unsubscribe function. */
export function subscribeDmCallSignals(listener: DmCallListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Dispatch opened call rumors to listeners (deduped by rumor id). */
export function deliverDmCallRumors(rumors: readonly OpenedDm[]): void {
  for (const rumor of rumors) {
    if (seenRumorIds.has(rumor.rumorId)) continue;
    seenRumorIds.add(rumor.rumorId);
    // Bound the dedup memory (insertion order = oldest first).
    if (seenRumorIds.size > 512) {
      let drop = seenRumorIds.size - 256;
      for (const id of seenRumorIds) {
        if (drop-- <= 0) break;
        seenRumorIds.delete(id);
      }
    }
    const signal = parseDmCall(rumor);
    if (!signal) continue;
    for (const listener of [...listeners]) listener(signal);
  }
}

/** Test seam: forget listeners and the dedup memory. */
export function _resetDmCallBusForTests(): void {
  listeners.clear();
  seenRumorIds.clear();
}
