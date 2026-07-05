import { verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import { controlGroupKey, random32 } from "@/concord-v2/lib/derive";
import {
  _resetStreamAuthRegistry,
  isStreamPubkey,
  onStreamKeysAdded,
  registerStreamKeys,
  signStreamAuths,
  streamPubkeys,
} from "@/concord-v2/lib/streamAuth";

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
});
