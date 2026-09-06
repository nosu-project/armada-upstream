import { verifyEvent } from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { controlGroupKey, random32 } from "@/concord/lib/derive";
import {
  _resetStreamAuthRegistry,
  isStreamPubkey,
  noteAuthResult,
  noteRelayChallenged,
  noteStreamAuthSent,
  onStreamAuthStale,
  onStreamKeysAdded,
  registerStreamKeys,
  resetRelayAuth,
  signStreamAuths,
  signStreamAuthsChunked,
  streamAuthsSettled,
  streamPubkeys,
  streamPubkeysForRelay,
} from "@/concord/lib/streamAuth";

const RELAY = "wss://relay.example.com";

function makeKey() {
  return controlGroupKey(random32(), random32(), 0n);
}

describe("streamAuth registry", () => {
  afterEach(() => _resetStreamAuthRegistry());

  it("registers keys idempotently and reports only new additions", () => {
    const a = makeKey();
    const b = makeKey();
    expect(registerStreamKeys([a, b])).toEqual([a.pk, b.pk]);
    // Re-registering the same keys adds nothing.
    expect(registerStreamKeys([a, b])).toEqual([]);
    // A mixed batch reports only the genuinely-new one.
    const c = makeKey();
    expect(registerStreamKeys([a, c])).toEqual([c.pk]);
    expect(new Set(streamPubkeys())).toEqual(new Set([a.pk, b.pk, c.pk]));
    expect(isStreamPubkey(a.pk)).toBe(true);
    expect(isStreamPubkey("f".repeat(64))).toBe(false);
  });

  it("notifies listeners with the newly-added pubkeys", () => {
    const seen: string[][] = [];
    const off = onStreamKeysAdded((added) => seen.push(added));
    const a = makeKey();
    registerStreamKeys([a]);
    registerStreamKeys([a]); // no-op, no notification
    off();
    registerStreamKeys([makeKey()]); // after unsubscribe, not seen
    expect(seen).toEqual([[a.pk]]);
  });

  it("signs a valid, verifiable kind-22242 AUTH per registered key", () => {
    const a = makeKey();
    const b = makeKey();
    registerStreamKeys([a, b]);

    const events = signStreamAuths("challenge-xyz", RELAY);
    expect(events).toHaveLength(2);
    for (const ev of events) {
      expect(ev.kind).toBe(22242);
      expect(verifyEvent(ev)).toBe(true);
      expect(ev.tags).toContainEqual(["relay", RELAY]);
      expect(ev.tags).toContainEqual(["challenge", "challenge-xyz"]);
    }
    // Signed by exactly the registered stream keys.
    expect(new Set(events.map((e) => e.pubkey))).toEqual(new Set([a.pk, b.pk]));
  });

  it("signs only the requested subset when given explicit pubkeys", () => {
    const a = makeKey();
    const b = makeKey();
    registerStreamKeys([a, b]);
    const events = signStreamAuths("c", RELAY, [a.pk]);
    expect(events.map((e) => e.pubkey)).toEqual([a.pk]);
  });

  it("scopes keys to their community's relays; unscoped keys sign everywhere", () => {
    const scoped = makeKey();
    const other = makeKey();
    const unscoped = makeKey();
    registerStreamKeys([scoped], [RELAY]);
    registerStreamKeys([other], ["wss://elsewhere.example.com"]);
    registerStreamKeys([unscoped]); // no relays: safe fallback, signs on all

    expect(new Set(streamPubkeysForRelay(RELAY))).toEqual(new Set([scoped.pk, unscoped.pk]));
    // Default signing (no explicit subset) follows the relay scope.
    const events = signStreamAuths("ch", RELAY);
    expect(new Set(events.map((e) => e.pubkey))).toEqual(new Set([scoped.pk, unscoped.pk]));
    // The other relay gets ITS key plus the unscoped one, never `scoped`.
    const elsewhere = signStreamAuths("ch", "wss://elsewhere.example.com");
    expect(new Set(elsewhere.map((e) => e.pubkey))).toEqual(new Set([other.pk, unscoped.pk]));
  });

  it("relay scoping normalizes URLs (trailing slash, bare host)", () => {
    const a = makeKey();
    registerStreamKeys([a], ["wss://relay.example.com/"]);
    expect(streamPubkeysForRelay("wss://relay.example.com")).toEqual([a.pk]);
    expect(streamPubkeysForRelay("relay.example.com")).toEqual([a.pk]);
    expect(streamPubkeysForRelay("wss://unrelated.example.com")).toEqual([]);
  });

  it("scopes only widen: re-registration adds relays, never removes them", () => {
    const a = makeKey();
    registerStreamKeys([a], ["wss://one.example.com"]);
    // A second community sharing the key on another relay widens the scope…
    expect(registerStreamKeys([a], ["wss://two.example.com"])).toEqual([a.pk]);
    // …and re-registering with a subset does NOT narrow it back.
    expect(registerStreamKeys([a], ["wss://one.example.com"])).toEqual([]);
    expect(streamPubkeysForRelay("wss://one.example.com")).toEqual([a.pk]);
    expect(streamPubkeysForRelay("wss://two.example.com")).toEqual([a.pk]);
    // Unscoped registration widens to everywhere; scoped never narrows it.
    registerStreamKeys([a]);
    registerStreamKeys([a], ["wss://one.example.com"]);
    expect(streamPubkeysForRelay("wss://anywhere.example.com")).toEqual([a.pk]);
  });

  it("an empty relay list falls back to unscoped, never scope-to-nowhere", () => {
    const a = makeKey();
    registerStreamKeys([a], []);
    expect(streamPubkeysForRelay(RELAY)).toEqual([a.pk]);
  });

  it("notifies listeners on scope widening (a challenged socket may need re-auth)", () => {
    const seen: string[][] = [];
    const a = makeKey();
    registerStreamKeys([a], ["wss://one.example.com"]);
    const off = onStreamKeysAdded((added) => seen.push(added));
    registerStreamKeys([a], ["wss://one.example.com"]); // identical: silent
    registerStreamKeys([a], ["wss://two.example.com"]); // widened: notify
    off();
    expect(seen).toEqual([[a.pk]]);
  });

  it("signStreamAuthsChunked yields the event loop between chunks", async () => {
    // 40 keys spans 3 chunks of 16. A macrotask queued at start must run
    // BEFORE iteration finishes — proving the loop yields instead of
    // monopolizing the thread (each signature is ~4ms of EC work).
    const keys = Array.from({ length: 40 }, () => makeKey());
    registerStreamKeys(keys, [RELAY]);

    let interleaved = false;
    let done = false;
    setTimeout(() => {
      interleaved = !done;
    }, 0);

    const events: NostrEvent[] = [];
    for await (const chunk of signStreamAuthsChunked("ch", RELAY)) {
      events.push(...chunk);
    }
    done = true;

    expect(events).toHaveLength(40);
    expect(new Set(events.map((e) => e.pubkey))).toEqual(new Set(keys.map((k) => k.pk)));
    for (const ev of events.slice(0, 2)) expect(verifyEvent(ev)).toBe(true);
    expect(interleaved).toBe(true);
  });

  // ── The paint-block mechanism ──────────────────────────────────────────────
  //
  // The three tests below prove WHY "chunked" doesn't get the signing under a
  // frame. The yield is `await setTimeout(0)` and it sits BETWEEN chunks
  // (guarded by `i > 0`); a single chunk of SIGN_CHUNK (16) signs runs
  // start-to-finish with no yield inside it. Each sign is ~4ms of EC work, so
  // one chunk is a ~64ms uninterruptible block on the main thread (several
  // hundred ms on a phone, 5-10x slower) — long past the 16.7ms frame budget.
  // The proof is deterministic: draining a single-chunk generator is
  // microtask-only, so a macrotask (setTimeout, ~ the timers/paint the block
  // would starve) queued before the drain cannot run until the whole chunk
  // finishes.

  it("does NOT yield WITHIN a chunk — one full chunk blocks the macrotask queue", async () => {
    // Exactly SIGN_CHUNK (16) keys = one chunk, so the loop's only
    // `await setTimeout(0)` (which is guarded by `i > 0`) never runs. A
    // macrotask queued before the drain therefore cannot interleave: the 16
    // synchronous signs run as one uninterruptible block. THIS is the paint
    // stall — the block that "chunking" is assumed to prevent but doesn't.
    const keys = Array.from({ length: 16 }, () => makeKey());
    registerStreamKeys(keys, [RELAY]);

    let macrotaskRanDuringDrain = false;
    let draining = true;
    setTimeout(() => {
      macrotaskRanDuringDrain = draining;
    }, 0);

    const events: NostrEvent[] = [];
    for await (const chunk of signStreamAuthsChunked("ch", RELAY)) {
      events.push(...chunk);
    }
    draining = false;

    expect(events).toHaveLength(16);
    // The macrotask did NOT run during the drain: the single chunk never ceded
    // the thread. (Contrast the 17-key case below, where a second chunk exists
    // and the between-chunk yield lets the same macrotask through.)
    expect(macrotaskRanDuringDrain).toBe(false);
  });

  it("yields ONLY between chunks — one key past the boundary is what admits a macrotask", async () => {
    // 17 keys forces a SECOND chunk, and with it the `await setTimeout(0)`
    // between chunk 1 and chunk 2. That single between-chunk yield is the only
    // place the loop cedes the thread — so the exact macrotask that a 16-key
    // (one-chunk) drain blocked now runs mid-drain. Same code, one more key:
    // the difference isolates the yield to the chunk BOUNDARY, never inside a
    // chunk.
    const keys = Array.from({ length: 17 }, () => makeKey());
    registerStreamKeys(keys, [RELAY]);

    let macrotaskRanDuringDrain = false;
    let draining = true;
    setTimeout(() => {
      macrotaskRanDuringDrain = draining;
    }, 0);

    const events: NostrEvent[] = [];
    for await (const chunk of signStreamAuthsChunked("ch", RELAY)) {
      events.push(...chunk);
    }
    draining = false;

    expect(events).toHaveLength(17);
    expect(macrotaskRanDuringDrain).toBe(true);
  });

  it("chunks by a fixed COUNT (16), so a chunk's blocking length scales with keys, not a time budget", async () => {
    // 33 keys → [16, 16, 1]. The boundary is a hardcoded count, independent of
    // how long each signature actually takes. The decode/verify paths slice by
    // a ~5ms WALL-CLOCK budget (DECODE_SLICE_MS / INLINE_SLICE_MS), which bounds
    // every blocking run to ~one frame on ANY device; here the longest
    // uninterruptible run is always 16 signs — ~64ms on desktop, several
    // hundred ms on a phone. That mismatch (count where it should be time) is
    // the fix target.
    const keys = Array.from({ length: 33 }, () => makeKey());
    registerStreamKeys(keys, [RELAY]);

    const chunkSizes: number[] = [];
    for await (const chunk of signStreamAuthsChunked("ch", RELAY)) {
      chunkSizes.push(chunk.length);
    }

    expect(chunkSizes).toEqual([16, 16, 1]);
    // The block length is capped by COUNT, not a time budget: a slower per-sign
    // cost makes each of these chunks proportionally longer with no adaptation.
    expect(Math.max(...chunkSizes)).toBe(16);
  });
});

describe("streamAuth per-relay ack state", () => {
  afterEach(() => _resetStreamAuthRegistry());

  it("an unchallenged relay is always settled (nothing to wait for)", () => {
    const a = makeKey();
    registerStreamKeys([a], [RELAY]);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true);
  });

  it("a challenged relay settles per-pubkey as the relay acks each AUTH", () => {
    const a = makeKey();
    const b = makeKey();
    registerStreamKeys([a, b], [RELAY]);
    noteRelayChallenged(RELAY);
    expect(streamAuthsSettled(RELAY, [a.pk, b.pk])).toBe(false);

    noteStreamAuthSent(RELAY, "ev-a", a.pk);
    noteStreamAuthSent(RELAY, "ev-b", b.pk);
    noteAuthResult(RELAY, "ev-a", true);
    expect(streamAuthsSettled(RELAY, [a.pk]), "acked key is settled").toBe(true);
    expect(streamAuthsSettled(RELAY, [a.pk, b.pk]), "unacked key still holds").toBe(false);

    noteAuthResult(RELAY, "ev-b", true);
    expect(streamAuthsSettled(RELAY, [a.pk, b.pk])).toBe(true);
  });

  it("a rejected AUTH (OK false) does not settle, and unknown OK ids are ignored", () => {
    const a = makeKey();
    registerStreamKeys([a], [RELAY]);
    noteRelayChallenged(RELAY);
    noteStreamAuthSent(RELAY, "ev-a", a.pk);
    noteAuthResult(RELAY, "unrelated-publish-ok", true); // e.g. an EVENT's OK
    noteAuthResult(RELAY, "ev-a", false);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(false);
  });

  it("resetRelayAuth clears the live-socket session (reconnect = fresh unauthenticated socket)", () => {
    const a = makeKey();
    registerStreamKeys([a], [RELAY]);
    noteRelayChallenged(RELAY);
    noteStreamAuthSent(RELAY, "ev-a", a.pk);
    noteAuthResult(RELAY, "ev-a", true);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true);

    resetRelayAuth(RELAY);
    // Unchallenged again — settled until the new socket's challenge arrives…
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true);
    // …after which the old acks must NOT count.
    noteRelayChallenged(RELAY);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(false);
  });

  it("ack state normalizes relay URLs", () => {
    const a = makeKey();
    registerStreamKeys([a], [RELAY]);
    noteRelayChallenged("wss://relay.example.com/");
    noteStreamAuthSent("relay.example.com", "ev-a", a.pk);
    noteAuthResult(`${RELAY}/`, "ev-a", true);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true);
  });
});

describe("streamAuth self-heal (never wedge until a restart)", () => {
  afterEach(() => {
    _resetStreamAuthRegistry();
    vi.useRealTimers();
  });

  it("a challenged-but-unacked relay self-heals past the stale window: reports settled AND fires a re-auth", () => {
    vi.useFakeTimers();
    const a = makeKey();
    registerStreamKeys([a], [RELAY]);
    noteRelayChallenged(RELAY);

    const reauthed: string[] = [];
    const off = onStreamAuthStale((url) => reauthed.push(url));

    // Inside the fresh-challenge window: still unsettled (a slow live ack wins).
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(false);
    expect(reauthed).toEqual([]);

    // Past the stale window: an AUTH frame or its OK was lost. Stop blocking
    // sweeps forever (the old restart-only wedge) and trigger a re-auth.
    vi.advanceTimersByTime(13_000);
    expect(streamAuthsSettled(RELAY, [a.pk]), "stale relay must stop reporting unsettled").toBe(true);
    expect(reauthed, "a re-auth must be fired for the stale relay").toEqual([RELAY]);

    off();
  });

  it("a re-auth that lands (OK acks arrive) settles cleanly without further re-auth storms", () => {
    vi.useFakeTimers();
    const a = makeKey();
    registerStreamKeys([a], [RELAY]);
    noteRelayChallenged(RELAY);

    let reauthCount = 0;
    const off = onStreamAuthStale(() => reauthCount++);

    vi.advanceTimersByTime(13_000);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true); // heals, fires re-auth #1
    expect(reauthCount).toBe(1);

    // The re-auth's AUTH lands and the relay acks it.
    noteStreamAuthSent(RELAY, "ev-a2", a.pk);
    noteAuthResult(RELAY, "ev-a2", true);

    // Now genuinely settled — no more re-auths regardless of how much time passes.
    vi.advanceTimersByTime(60_000);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true);
    expect(reauthCount, "an acked relay must not keep firing re-auths").toBe(1);

    off();
  });

  it("re-arms the window so a stale relay fires ONE re-auth per window, not a storm", () => {
    vi.useFakeTimers();
    const a = makeKey();
    registerStreamKeys([a], [RELAY]);
    noteRelayChallenged(RELAY);

    let reauthCount = 0;
    const off = onStreamAuthStale(() => reauthCount++);

    vi.advanceTimersByTime(13_000);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true); // heals, fires re-auth #1
    expect(reauthCount).toBe(1);

    // Immediately re-checking (the sweep polls every ~50ms) must NOT re-fire —
    // the window was re-armed, so the gate goes back to WAITING for the
    // re-auth's ack (returns false) rather than firing another re-auth.
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(false);
    expect(reauthCount).toBe(1);

    // Only after the NEW window elapses without an ack does it heal + fire again.
    vi.advanceTimersByTime(13_000);
    expect(streamAuthsSettled(RELAY, [a.pk])).toBe(true);
    expect(reauthCount).toBe(2);

    off();
  });
});
