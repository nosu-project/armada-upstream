/**
 * Event verification that pays the Schnorr check ONCE per event id.
 *
 * Every non-wrap event a relay serves is Schnorr-verified synchronously in the
 * WebSocket message handler (~1–2ms each on a phone), and nothing deduped that
 * across relays or query rounds: a measured boot that stored ~2k unique events
 * received ~6k copies, so roughly two thirds of the main-thread crypto was
 * re-proving content already proven authentic. This memo makes verification
 * O(unique events) instead of O(copies received).
 *
 * The memo is sound because an event id IS the sha256 of the event's content:
 *
 *  - The claimed id is ALWAYS recomputed from the copy in hand first. The memo
 *    maps an id to "content hashing to this was verified", and the recomputed
 *    hash is the only thing binding THIS copy to that claim — without it, any
 *    content could ride a known-good id.
 *  - Only then may the Schnorr verify be skipped: an identical hash means
 *    identical content, and a valid signature over that content has already
 *    been seen. A duplicate copy carrying a MANGLED sig is thereby accepted —
 *    deliberately: the content is authentic regardless, and the stores strip
 *    `sig` before persisting (see mainEventStore), so the bad copy's sig
 *    outlives nothing.
 *  - A FAILED verify is never memoized, so a forged copy cannot poison the id
 *    for the honest copy that arrives later.
 *
 * The hash is recomputed per copy on purpose: sha256 of a ~1KB event is
 * microseconds against the Schnorr verify's milliseconds, and it is the whole
 * of the memo's security argument.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { getEventHash } from "nostr-tools/pure";

import { IdLog, type IdLogKV } from "@/lib/db/idLog";
import { perfCount } from "@/lib/perf";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The memo holds the first 128 bits of each id. The recomputed hash is still
 * compared against the FULL claimed id first (see {@link hashGate}); the prefix
 * only answers "was content hashing to this verified", and for a different
 * event to reuse a verdict it would need a hash agreeing on 128 bits with one
 * already proven — a second preimage, not a lookup. Half the bytes to hold and
 * to persist.
 */
const MEMO_KEY_CHARS = 32;
const memoKey = (id: string): string => id.slice(0, MEMO_KEY_CHARS);

/** Ids persisted per KV chunk, and chunks kept. */
const CHUNK_IDS = 1024;
const KEEP_CHUNKS = 24;

/**
 * Bounded FIFO — sized for what the persisted chunks can refill, so a relaunch
 * starts with roughly what the last session had proven.
 */
const MAX_IDS = CHUNK_IDS * KEEP_CHUNKS;
const verified = new Set<string>();

/**
 * Record that content hashing to `id` carried a valid signature. The bounded
 * FIFO is the whole memo, so both the sync and the batched paths below insert
 * through here — a second copy of the eviction would be a second contract.
 */
function rememberVerified(id: string): void {
  const key = memoKey(id);
  if (verified.has(key)) return;
  if (verified.size >= MAX_IDS) {
    // Oldest insertion first — `Set` iterates in insertion order.
    const oldest = verified.keys().next();
    if (!oldest.done) verified.delete(oldest.value);
  }
  verified.add(key);
  persistence?.log.add(key);
}

// ── Persistence ─────────────────────────────────────────────────────────────
//
// A session-only memo re-proved everything on every launch: the profiles, lists
// and Concord seals a relaunch re-reads are the SAME events the last session
// verified, and a Schnorr verify is ~2ms on a desktop and several times that on
// a phone. The verdicts are kept in an append-only KV log (see IdLog), so an
// add rewrites one small chunk rather than the whole set.
//
// A verdict is a fact about content, not about an account, so the log is not
// scoped by account; it goes with the rest of ArmadaDB when client storage is
// purged.

let persistence: { log: IdLog; started: boolean } | undefined;

/**
 * Keep verdicts across launches in `kv`. Nothing is read until the first
 * verify asks (so installing this at startup opens no store); the saved
 * verdicts then merge into the memo as they land, and a verify that runs before
 * they have is simply not saved any work.
 */
export function persistVerifiedIds(kv: () => IdLogKV): void {
  if (persistence) return;
  persistence = {
    log: new IdLog(kv, { prefix: "verified-ids:", idChars: MEMO_KEY_CHARS, chunkIds: CHUNK_IDS, keepChunks: KEEP_CHUNKS, flushMs: 2_000 }),
    started: false,
  };
}

function startPersistence(): void {
  if (!persistence || persistence.started) return;
  persistence.started = true;
  void persistence.log.load().then((saved) => {
    // Oldest first, ahead of anything this session already proved, so the
    // FIFO evicts the previous sessions' verdicts before this one's.
    const session = [...verified];
    verified.clear();
    for (const key of saved) verified.add(key);
    for (const key of session) verified.add(key);
    while (verified.size > MAX_IDS) {
      const oldest = verified.keys().next();
      if (oldest.done) break;
      verified.delete(oldest.value);
    }
  });
}

/**
 * The main-thread half of the memo's security argument, shared by both the
 * sync {@link verifyEventOnce} and the batched {@link verifyEventsOnce}: an
 * event is only a candidate for skipping (or deferring) the Schnorr verify once
 * its claimed id is proven to be the hash of the copy in hand.
 *
 * Returns `"decided"` — the event needs no EC verify, `result` is final — or
 * `"needs-ec"` — hash-bound but not yet in the memo, so the Schnorr verify must
 * still run against `event.sig`. This is deliberately kept in this file (never
 * shipped to a worker) because recomputing the hash IS the memo's security
 * argument: a worker that both hashed and verified could be handed content that
 * doesn't match its id and would have no honest copy to compare against.
 */
function hashGate(event: NostrEvent): { state: "decided"; result: boolean } | { state: "needs-ec" } {
  startPersistence();
  let hash: string;
  try {
    // `getEventHash` serializes, and serializing an event with missing or
    // ill-typed fields THROWS rather than returning a non-matching hash. A
    // malformed event has to read as unverified, not as an exception: callers
    // include `openWrap`, whose seal is JSON parsed out of a decrypted payload
    // and shaped by whoever holds the group key. (nostr-tools' own
    // `verifyEvent` catches this internally; so must the memoized form.)
    hash = getEventHash(event);
  } catch {
    return { state: "decided", result: false };
  }
  if (hash !== event.id) return { state: "decided", result: false };
  if (verified.has(memoKey(event.id))) return { state: "decided", result: true };
  return { state: "needs-ec" };
}

/** Verify `event`, skipping the Schnorr check for an id already verified. */
export function verifyEventOnce(event: NostrEvent): boolean {
  const start = performance.now();

  const gate = hashGate(event);
  if (gate.state === "decided") {
    // A decided `true` can only have come from the memo.
    perfCount(
      gate.result ? "crypto.verifyEvent (memo hit)" : "crypto.verifyEvent",
      performance.now() - start,
      1,
      "events",
    );
    return gate.result;
  }

  let ok = false;
  try {
    // Inside the try: malformed hex in any field throws, and reads as invalid.
    ok = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    ok = false;
  }
  if (ok) rememberVerified(event.id);
  perfCount("crypto.verifyEvent", performance.now() - start, 1, "events");
  // Every Schnorr verify actually performed, on any thread and by either
  // path — the number the memo exists to keep down.
  perfCount("crypto.ec.verify (sync)", 0, 1, "verifies");
  return ok;
}

/** The three fields an out-of-process EC verifier needs, and nothing else. */
export interface VerifyTriple {
  sig: string;
  id: string;
  pubkey: string;
}

/**
 * A pluggable Schnorr batch verifier: given `(sig, id, pubkey)` triples,
 * resolve one boolean per triple in order. The default is main-thread `@noble`;
 * `verifyPool.ts` supplies a worker-backed one so a large first decode's EC
 * math runs off the main thread. The verifier does the EC ONLY — the hash bind
 * and the memo stay here (see {@link hashGate}).
 */
export type EcVerifyBatch = (triples: VerifyTriple[]) => Promise<boolean[]>;

/**
 * Batched, memoized verification. Same security argument as {@link
 * verifyEventOnce}, applied to a whole batch: every event is hash-bound and
 * memo-checked on THIS thread; only the residue that actually needs a Schnorr
 * verify is handed to `ecVerify` (which may run it off-thread). A valid result
 * is remembered so a later copy — or the sync path — hits the memo.
 *
 * Returns one boolean per input event, in input order. `ecVerify` failing
 * wholesale (a dead worker) reads as "unverified" for the residue, never as an
 * exception: the caller drops those events, exactly as a bad sig would.
 *
 * The residue is deduped by the WHOLE triple (id + sig + pubkey), not by id:
 * the same seal arriving from two relays in one batch is one EC verify, with
 * every identical copy taking that one verdict — sound for the same reason the
 * memo is, since both copies were hash-bound to the id here. The sig must be
 * part of the key: keyed by id alone, a same-id copy carrying a MANGLED sig —
 * which a keyholder can mint from anyone's real seal — would carry its false
 * verdict onto the honest copy in the same batch, and `openChatBatch` memoizes
 * a false verdict per wrap for the session. Copies with different sigs verify
 * independently, exactly as the sync path would.
 */
export async function verifyEventsOnce(
  events: NostrEvent[],
  ecVerify: EcVerifyBatch,
): Promise<boolean[]> {
  const start = performance.now();
  const result = new Array<boolean>(events.length);
  const residue: VerifyTriple[] = [];
  // Which result slots each residue triple answers — an identical duplicate
  // adds a slot to an existing triple's list rather than a second triple.
  const residueSlots: number[][] = [];
  const residueByTriple = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const gate = hashGate(events[i]);
    if (gate.state === "decided") {
      result[i] = gate.result;
      continue;
    }
    const key = `${events[i].id}|${events[i].sig}|${events[i].pubkey}`;
    const at = residueByTriple.get(key);
    if (at !== undefined) {
      residueSlots[at].push(i);
      continue;
    }
    residueByTriple.set(key, residue.length);
    residue.push({ sig: events[i].sig, id: events[i].id, pubkey: events[i].pubkey });
    residueSlots.push([i]);
  }

  // The gate + residue build is the main-thread cost this counter reports;
  // the EC verify below may run off-thread, and awaiting it is wall clock,
  // not CPU — `verifyPool` / the verifier's own counters account for that.
  perfCount("crypto.verifyEvents", performance.now() - start, events.length, "events");

  if (residue.length > 0) {
    perfCount("crypto.ec.verify (batched)", 0, residue.length, "verifies");
    let oks: boolean[];
    try {
      oks = await ecVerify(residue);
    } catch {
      oks = residue.map(() => false);
    }
    for (let j = 0; j < residue.length; j++) {
      const ok = oks[j] === true;
      for (const slot of residueSlots[j]) result[slot] = ok;
      if (ok) rememberVerified(residue[j].id);
    }
  }

  return result;
}

/** Test seam: forget every verified id, and stop persisting. */
export function _resetVerifyCacheForTests(): void {
  verified.clear();
  persistence = undefined;
}
