import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetDmCallBusForTests,
  deliverDmCallRumors,
  DM_CALL_RING_MS,
  dmCallCollisionWinner,
  dmCallKeys,
  dmCallTags,
  isDmOfferFresh,
  mintDmCall,
  parseDmCall,
  subscribeDmCallSignals,
} from "@/lib/dmCall";
import { KIND_DM_CALL, type OpenedDm } from "@/lib/nip17/protocol";

const PEER = "a".repeat(64);
const AUTHOR = "b".repeat(64);

function opened(overrides: Partial<OpenedDm> & { tags?: string[][] }): OpenedDm {
  return {
    rumorId: "r".repeat(64),
    author: AUTHOR,
    kind: KIND_DM_CALL,
    content: "offer",
    tags: [],
    createdAt: Math.floor(Date.now() / 1000),
    peers: [AUTHOR],
    wrapId: "w".repeat(64),
    ...overrides,
  };
}

afterEach(() => _resetDmCallBusForTests());

describe("dmCallKeys", () => {
  it("derives deterministically, with the call id equal to the room pubkey", () => {
    const { secretHex, callId } = mintDmCall();
    const a = dmCallKeys(secretHex);
    const b = dmCallKeys(secretHex);
    expect(a.room.pk).toBe(callId);
    expect(b.room.pk).toBe(callId);
    expect(a.mediaKey).toEqual(b.mediaKey);
    // Media material is distinct from the signing key.
    expect(Buffer.from(a.mediaKey).toString("hex")).not.toBe(
      Buffer.from(a.room.sk).toString("hex"),
    );
  });

  it("derives distinct rooms for distinct secrets", () => {
    expect(mintDmCall().callId).not.toBe(mintDmCall().callId);
  });
});

describe("parseDmCall", () => {
  it("round-trips an offer built with dmCallTags", () => {
    const { secretHex, callId } = mintDmCall();
    const signal = parseDmCall(
      opened({
        tags: dmCallTags(PEER, callId, { secretHex, broker: "https://armada.buzz" }),
        peers: [AUTHOR],
      }),
    );
    expect(signal).toMatchObject({
      phase: "offer",
      callId,
      secretHex,
      broker: "https://armada.buzz",
      author: AUTHOR,
    });
  });

  it("refuses an offer whose secret does not derive its claimed call id", () => {
    const { secretHex } = mintDmCall();
    const { callId: otherCallId } = mintDmCall();
    expect(
      parseDmCall(
        opened({
          tags: dmCallTags(PEER, otherCallId, { secretHex, broker: "https://armada.buzz" }),
        }),
      ),
    ).toBeNull();
  });

  it("refuses an offer without a usable broker hint", () => {
    const { secretHex, callId } = mintDmCall();
    expect(
      parseDmCall(opened({ tags: dmCallTags(PEER, callId, { secretHex }) })),
    ).toBeNull();
    expect(
      parseDmCall(
        opened({
          tags: dmCallTags(PEER, callId, { secretHex, broker: "http://plaintext.example" }),
        }),
      ),
    ).toBeNull();
  });

  it("parses non-offer phases without secret or broker", () => {
    const { callId } = mintDmCall();
    for (const phase of ["answer", "decline", "end", "ringing", "busy"] as const) {
      const signal = parseDmCall(
        opened({ content: phase, tags: dmCallTags(PEER, callId) }),
      );
      expect(signal?.phase).toBe(phase);
      expect(signal?.secretHex).toBeUndefined();
    }
  });

  it("refuses foreign kinds, unknown phases, and group conversations", () => {
    const { secretHex, callId } = mintDmCall();
    const tags = dmCallTags(PEER, callId, { secretHex, broker: "https://armada.buzz" });
    expect(parseDmCall(opened({ kind: 14, tags }))).toBeNull();
    expect(parseDmCall(opened({ content: "ring", tags }))).toBeNull();
    expect(parseDmCall(opened({ tags, peers: [AUTHOR, PEER] }))).toBeNull();
  });
});

describe("dmCallCollisionWinner", () => {
  it("lets both sides agree on the same call", () => {
    // Each side passes (self, peer): the two answers must name one call.
    expect(dmCallCollisionWinner(PEER, AUTHOR)).toBe("ours");
    expect(dmCallCollisionWinner(AUTHOR, PEER)).toBe("theirs");
  });
});

describe("isDmOfferFresh", () => {
  it("accepts inside the ring window, refuses stale and far-future offers", () => {
    const { secretHex, callId } = mintDmCall();
    const base = opened({
      tags: dmCallTags(PEER, callId, { secretHex, broker: "https://armada.buzz" }),
    });
    const signal = parseDmCall(base)!;
    const now = signal.createdAtMs;
    expect(isDmOfferFresh(signal, now + DM_CALL_RING_MS - 1000)).toBe(true);
    expect(isDmOfferFresh(signal, now + DM_CALL_RING_MS + 1000)).toBe(false);
    // A forged future stamp can't extend its own ring window.
    expect(isDmOfferFresh(signal, now - 120_000)).toBe(false);
  });
});

describe("the signal bus", () => {
  it("dispatches parsed signals once per rumor id", () => {
    const { secretHex, callId } = mintDmCall();
    const rumor = opened({
      tags: dmCallTags(PEER, callId, { secretHex, broker: "https://armada.buzz" }),
    });
    const listener = vi.fn();
    subscribeDmCallSignals(listener);
    deliverDmCallRumors([rumor]);
    deliverDmCallRumors([rumor]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({ callId, phase: "offer" });
  });

  it("silently skips rumors that are not call signals", () => {
    const listener = vi.fn();
    subscribeDmCallSignals(listener);
    deliverDmCallRumors([opened({ kind: 14, content: "hello", rumorId: "x".repeat(64) })]);
    expect(listener).not.toHaveBeenCalled();
  });
});
