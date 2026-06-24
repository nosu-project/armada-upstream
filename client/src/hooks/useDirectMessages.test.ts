import { describe, expect, it } from "vitest";

import {
  dmCounterparty,
  mergeDmEvents,
  mergeDmThread,
  type DecryptedDM,
} from "@/hooks/useDirectMessages";

import type { NostrEvent } from "@nostrify/nostrify";

// Regression tests for the DM "disappearing-messages" bug (bug class 2:
// replace-not-merge). Before the fix, both DM query functions returned the raw
// relay result, so a sparse/empty relay read — or a transient NIP-04 decrypt
// failure — could SHRINK or blank an already-loaded conversation list / thread.
// The fix merges the network result with the cache as a floor (mergeDmEvents /
// mergeDmThread), mirroring the Concord pattern.

const SELF = "a".repeat(64);
const PEER1 = "b".repeat(64);
const PEER2 = "c".repeat(64);

function dmEvent(opts: { id: string; from: string; to: string; createdAt?: number }): NostrEvent {
  return {
    id: opts.id.padEnd(64, "0").slice(0, 64),
    pubkey: opts.from,
    created_at: opts.createdAt ?? 1000,
    kind: 4,
    tags: [["p", opts.to]],
    content: "ciphertext",
    sig: "f".repeat(128),
  };
}

function msg(id: string, createdAt: number, extra: Partial<DecryptedDM> = {}): DecryptedDM {
  return { id, pubkey: SELF, created_at: createdAt, content: `m${id}`, ...extra };
}

describe("dmCounterparty", () => {
  it("received message: counterparty is the sender", () => {
    expect(dmCounterparty(dmEvent({ id: "1", from: PEER1, to: SELF }), SELF)).toBe(PEER1);
  });
  it("sent message: counterparty is the first p tag", () => {
    expect(dmCounterparty(dmEvent({ id: "1", from: SELF, to: PEER1 }), SELF)).toBe(PEER1);
  });
});

describe("mergeDmEvents (conversation-list merge floor)", () => {
  const cached = [
    dmEvent({ id: "1", from: PEER1, to: SELF }),
    dmEvent({ id: "2", from: PEER2, to: SELF }),
  ];

  it("keeps cached conversations when the relay returns NOTHING", () => {
    // The disappearing-list bug: an empty relay read must not shrink the list.
    expect(mergeDmEvents(cached, []).map((e) => e.id.slice(0, 1)).sort()).toEqual(["1", "2"]);
  });

  it("keeps cached conversations when the relay returns FEWER (sparse page)", () => {
    const sparse = [dmEvent({ id: "1", from: PEER1, to: SELF })]; // peer2 missing
    const merged = mergeDmEvents(cached, sparse);
    expect(merged.map((e) => e.id.slice(0, 1)).sort()).toEqual(["1", "2"]);
  });

  it("adds new conversations the cache didn't have", () => {
    const incoming = [dmEvent({ id: "3", from: "d".repeat(64), to: SELF })];
    expect(mergeDmEvents(cached, incoming).map((e) => e.id.slice(0, 1)).sort()).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("dedupes by id (a re-seen event doesn't duplicate)", () => {
    const echo = [dmEvent({ id: "1", from: PEER1, to: SELF })];
    expect(mergeDmEvents(cached, echo)).toHaveLength(2);
  });
});

describe("mergeDmThread (thread merge floor)", () => {
  const cached = [msg("1", 100), msg("2", 200), msg("3", 300)];

  it("keeps decrypted messages when the relay returns NOTHING", () => {
    // Disappearing-thread via sparse read.
    expect(mergeDmThread(cached, []).map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("keeps decrypted messages when a transient decrypt failure yields fewer", () => {
    // The decrypt loop SKIPS messages it can't decrypt, so a transient NIP-07
    // batch rejection yields a short `decrypted[]`. The merge must not let that
    // blank the already-shown thread.
    const partial = [msg("1", 100)]; // 2 and 3 failed to decrypt this round
    expect(mergeDmThread(cached, partial).map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it("appends new messages and sorts oldest-first", () => {
    const incoming = [msg("4", 400), msg("0", 50)];
    expect(mergeDmThread(cached, incoming).map((m) => m.id)).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("dedupes by id", () => {
    expect(mergeDmThread(cached, [msg("2", 200)])).toHaveLength(3);
  });

  it("preserves an optimistic status when the network echoes the same id without one", () => {
    // A "sending" message in cache, echoed back by the relay with no status:
    // the badge must survive (the confirmed-publish path clears it explicitly).
    const pending = [msg("5", 500, { status: "sending" })];
    const echo = [msg("5", 500)]; // network copy has no status
    const merged = mergeDmThread(pending, echo);
    expect(merged.find((m) => m.id === "5")?.status).toBe("sending");
  });

  it("an incoming status update overrides the cached one", () => {
    const failed = [msg("5", 500, { status: "failed" })];
    const retried = [msg("5", 500, { status: "sending" })];
    expect(mergeDmThread(failed, retried).find((m) => m.id === "5")?.status).toBe("sending");
  });
});
