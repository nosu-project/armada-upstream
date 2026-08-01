/**
 * The verify memo's security argument, pinned:
 *
 *  - the hash is recomputed for EVERY copy, so a verified id can never bless
 *    different content;
 *  - a failed verify is never memoized, so a forged copy can't poison the id
 *    for the honest copy arriving later;
 *  - the memo genuinely engages: a re-received copy of identical content is
 *    accepted without a second Schnorr pass (even with a mangled sig — the
 *    documented, deliberate acceptance).
 */
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it } from "vitest";

import { _resetVerifyCacheForTests, verifyEventOnce } from "./verifyCache";

import type { NostrEvent } from "@nostrify/nostrify";

function signed(content = "hello"): NostrEvent {
  return finalizeEvent(
    { kind: 1, content, tags: [], created_at: 1000 },
    generateSecretKey(),
  );
}

beforeEach(() => {
  _resetVerifyCacheForTests();
});

describe("verifyEventOnce", () => {
  it("accepts a validly signed event and rejects a bad signature", () => {
    expect(verifyEventOnce(signed())).toBe(true);
    expect(verifyEventOnce({ ...signed("other"), sig: "00".repeat(64) })).toBe(false);
  });

  it("never lets a verified id bless different content", () => {
    const ev = signed();
    expect(verifyEventOnce(ev)).toBe(true);
    // Same claimed id and sig, tampered content: the recomputed hash no longer
    // matches the id, so the memo entry for that id must not apply.
    expect(verifyEventOnce({ ...ev, content: "tampered" })).toBe(false);
  });

  it("accepts a re-received copy of identical content without re-verifying", () => {
    const ev = signed();
    expect(verifyEventOnce(ev)).toBe(true);
    // Identical content (hash matches the verified id) with a garbage sig:
    // accepted, because the content is authentic and sigs are stripped before
    // storage. Passing here is also the proof that the memo engaged at all —
    // a full verify of this copy would reject it.
    expect(verifyEventOnce({ ...ev, sig: "00".repeat(64) })).toBe(true);
  });

  it("does not memoize a failed verify — the honest copy still passes later", () => {
    const ev = signed();
    expect(verifyEventOnce({ ...ev, sig: "00".repeat(64) })).toBe(false);
    expect(verifyEventOnce(ev)).toBe(true);
  });
});
