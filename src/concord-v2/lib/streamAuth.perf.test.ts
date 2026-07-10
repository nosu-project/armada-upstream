/**
 * Performance evidence for NIP-42 stream-auth signing (streamAuth.ts).
 *
 * Theory under test (sibling of the groupKey() churn fixed in derive.ts):
 * `signStreamAuths()` signs a kind-22242 event with `finalizeEvent()` for
 * EVERY registered stream key on EVERY challenge of EVERY relay —
 * NostrProvider's auth callback passes no `pubkeys` subset. The registry holds
 * the keys of ALL communities (core + per-channel × held epochs), so:
 *
 *   - one challenge costs O(total keys) Schnorr signatures, even though a
 *     relay only needs the keys of the communities it actually hosts;
 *   - every socket reopen (mobile reconnect churn) re-issues a challenge;
 *   - registering any new key force-closes EVERY challenged socket
 *     (NostrProvider.tsx:421), so one community join triggers a
 *     relays × keys signing burst.
 *
 * These tests measure the real module at realistic registry scale and pin the
 * fact the fix rests on: cost is linear in the signed set, so per-relay
 * scoping cuts it proportionally. They also pin a NEGATIVE result: signing
 * with the registry's known pubkey (skipping finalizeEvent's getPublicKey)
 * saves ~nothing, because schnorr.sign recomputes the public point internally
 * — that micro-optimization is not worth pursuing.
 */

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { getEventHash, verifyEvent, type NostrEvent, type UnsignedEvent } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { channelGroupKey, type GroupKey } from "@/concord-v2/lib/derive";
import {
  _resetStreamAuthRegistry,
  registerStreamKeys,
  signStreamAuths,
  streamPubkeys,
} from "@/concord-v2/lib/streamAuth";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic 32 bytes from a label (stable across runs). */
function b32(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(label));
}

/**
 * A realistic full registry: 10 communities × ~45 stream keys each (20
 * channels × 2 held root epochs + core control/guestbook/dissolved/rekey
 * addresses) ≈ the ~450-key registry of the derive.perf "moderate user".
 * Derivation itself is memoized (derive.ts), so this measures SIGNING only.
 */
const COMMUNITIES = 10;
const KEYS_PER_COMMUNITY = 45;

function communityKeys(n: number): GroupKey[] {
  const secret = b32(`auth-root-${n}`);
  return Array.from({ length: KEYS_PER_COMMUNITY }, (_, i) =>
    channelGroupKey(secret, b32(`auth-channel-${n}-${i}`), 0),
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

afterEach(() => _resetStreamAuthRegistry());

// ── The measurements ─────────────────────────────────────────────────────────

describe("NIP-42 stream-auth signing cost (perf evidence)", () => {
  it("one challenge signs the ENTIRE registry — O(all keys), seconds at scale", { timeout: 120_000 }, () => {
    const perCommunity = Array.from({ length: COMMUNITIES }, (_, n) => communityKeys(n));
    for (const keys of perCommunity) registerStreamKeys(keys);
    const total = streamPubkeys().length;
    expect(total).toBe(COMMUNITIES * KEYS_PER_COMMUNITY);

    // Warm-up (noble precompute tables).
    signStreamAuths("warmup", "wss://relay.example.com", streamPubkeys().slice(0, 10));

    // What NostrProvider.sendStreamAuths does today: no pubkeys subset.
    const t0 = performance.now();
    const events = signStreamAuths("challenge-nonce-1", "wss://relay.example.com");
    const fullPass = performance.now() - t0;

    expect(events.length).toBe(total);
    expect(verifyEvent(events[0])).toBe(true); // they are real, valid signatures

    // The remedy's premise: cost is linear in the signed set, so scoping a
    // challenge to one community's keys divides the cost by the community
    // fan-out. Measure a one-community subset (what a single-community relay
    // actually needs).
    const scopedPks = perCommunity[0].map((k) => k.pk);
    const scopedTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t1 = performance.now();
      const scoped = signStreamAuths(`challenge-nonce-${i + 2}`, "wss://relay.example.com", scopedPks);
      scopedTimes.push(performance.now() - t1);
      expect(scoped.length).toBe(KEYS_PER_COMMUNITY);
    }
    const scopedPass = median(scopedTimes);

    console.log(
      `[perf] signStreamAuths, full registry (${total} keys): ${fullPass.toFixed(0)}ms per challenge — ` +
        `every socket (re)open per relay; a new-key mass reconnect over 4 relays ≈ ${(fullPass * 4).toFixed(0)}ms ` +
        `of main-thread signing (phones 5-10x slower). ` +
        `Scoped to one community (${KEYS_PER_COMMUNITY} keys): ${scopedPass.toFixed(0)}ms ` +
        `(${(fullPass / scopedPass).toFixed(1)}x cheaper).`,
    );

    // Linearity: the full pass must cost ~COMMUNITIES× the scoped pass. Wide
    // margins for CI noise: at least 3x (measured ~10x), and the scoped pass
    // beats the full pass by at least 3x.
    expect(fullPass).toBeGreaterThan(scopedPass * 3);
  });

  it("NEGATIVE result: skipping finalizeEvent's getPublicKey saves ~nothing", { timeout: 60_000 }, () => {
    // Theory tested: finalizeEvent(sk) internally recomputes getPublicKey(sk)
    // although the registry is keyed by that pubkey — so building the event
    // with the known pk and calling schnorr.sign directly should halve the EC
    // work. MEASURED: it doesn't (~1.0x) — schnorr.sign recomputes the public
    // point internally anyway (BIP-340 needs it for parity), and noble's
    // precomputed base tables make the extra fixed-base mult cheap. Pinned
    // here so nobody re-proposes the micro-optimization; the real fix is
    // scoping the signed SET (previous test).
    const keys = communityKeys(0);
    registerStreamKeys(keys);
    const pks = keys.map((k) => k.pk);

    signStreamAuths("warmup", "wss://r", pks.slice(0, 5)); // warm-up
    const t0 = performance.now();
    const current = signStreamAuths("bench-challenge", "wss://r", pks);
    const currentMs = performance.now() - t0;

    const createdAt = Math.floor(Date.now() / 1000);
    const lean = (pk: string, sk: Uint8Array): NostrEvent => {
      const unsigned: UnsignedEvent = {
        kind: 22242,
        content: "",
        tags: [["relay", "wss://r"], ["challenge", "bench-challenge"]],
        created_at: createdAt,
        pubkey: pk,
      };
      const id = getEventHash(unsigned);
      const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
      return { ...unsigned, id, sig };
    };
    lean(keys[0].pk, keys[0].sk); // warm-up
    const t1 = performance.now();
    const leanEvents = keys.map((k) => lean(k.pk, k.sk));
    const leanMs = performance.now() - t1;

    console.log(
      `[perf] ${pks.length} NIP-42 signs: finalizeEvent ${currentMs.toFixed(0)}ms vs ` +
        `known-pubkey sign ${leanMs.toFixed(0)}ms (${(currentMs / leanMs).toFixed(2)}x) — ` +
        `not worth it; per-signature cost is ~${(currentMs / pks.length).toFixed(1)}ms either way`,
    );

    // Both paths produce real, equivalent NIP-42 auths (kept as a correctness
    // pin for whatever the eventual fix ships). No timing assertion: the two
    // are within noise of each other — that IS the finding.
    for (const ev of leanEvents.slice(0, 3)) expect(verifyEvent(ev)).toBe(true);
    expect(leanEvents[0].pubkey).toBe(current[0].pubkey);
    expect(leanEvents[0].kind).toBe(22242);
    expect(leanEvents[0].tags).toEqual(current[0].tags);
  });

  it("quantifies the mass-reconnect burst a single new-key registration triggers", { timeout: 120_000 }, () => {
    for (let n = 0; n < COMMUNITIES; n++) registerStreamKeys(communityKeys(n));
    const total = streamPubkeys().length;

    // NostrProvider.tsx:421-453: registering ANY new key closes every
    // already-challenged socket; each reopens, gets a fresh challenge, and
    // re-signs the FULL registry. Simulate 4 relays' worth of challenges.
    const RELAYS = 4;
    signStreamAuths("warmup", "wss://r0", streamPubkeys().slice(0, 10)); // warm-up
    const t0 = performance.now();
    let signed = 0;
    for (let r = 0; r < RELAYS; r++) {
      signed += signStreamAuths(`reconnect-challenge-${r}`, `wss://relay-${r}.example.com`).length;
    }
    const burst = performance.now() - t0;

    console.log(
      `[perf] mass-reconnect burst (${RELAYS} relays × ${total} keys = ${signed} signatures): ` +
        `${burst.toFixed(0)}ms of synchronous main-thread signing — triggered by ONE new community/channel/rekey ` +
        `(phones 5-10x slower: ~${((burst * 5) / 1000).toFixed(1)}-${((burst * 10) / 1000).toFixed(1)}s of jank)`,
    );

    expect(signed).toBe(RELAYS * total);
    expect(burst).toBeGreaterThan(0);
  });
});
