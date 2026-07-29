import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDmFilters,
  buildThreadPlaceholders,
  buildThreadRows,
  decryptThreadRows,
  DM_PAGE_SIZE,
  dmCounterparty,
  hasMoreCursor,
  mergeDmEvents,
  mergeDmThread,
  nextDirectionCursor,
  shouldShowDmThreadLoading,
  type DecryptedDM,
  type RelayCursors,
} from "@/hooks/useDirectMessages";
import { clearRenderedPlaintext, setRenderedPlaintext } from "@/hooks/dmRenderCache";

import type { NostrEvent } from "@nostrify/nostrify";

// Regression tests for the DM "disappearing-messages" bug (bug class 2:
// replace-not-merge). Before the fix, both DM query functions returned the raw
// relay result, so a sparse/empty relay read — or a transient NIP-04 decrypt
// failure — could SHRINK or blank an already-loaded conversation list / thread.
// The fix merges the network result with the cache as a floor (mergeDmEvents /
// mergeDmThread), mirroring the Concord pattern. buildThreadRows additionally
// bounds eager decryption to the newest screenful (viewport-lazy decrypt).

afterEach(() => clearRenderedPlaintext());

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

  it("never downgrades a decrypted row back to an encrypted placeholder", () => {
    // The thread refetch re-runs buildThreadRows, which may emit an OLD message
    // as a placeholder. If that message was already lazily decrypted (and is in
    // the cache as plaintext), the merge must keep the plaintext, not blank it.
    const decryptedRow = [msg("9", 900)]; // content "m9", not encrypted
    const placeholder = [{ id: "9", pubkey: SELF, created_at: 900, content: "", encrypted: true }];
    const merged = mergeDmThread(decryptedRow, placeholder);
    const row = merged.find((m) => m.id === "9")!;
    expect(row.content).toBe("m9");
    expect(row.encrypted).toBeUndefined();
  });

  it("still takes a fresh status even when keeping the decrypted content", () => {
    const decryptedRow = [msg("9", 900)];
    const placeholderWithStatus = [
      { id: "9", pubkey: SELF, created_at: 900, content: "", encrypted: true, status: "failed" as const },
    ];
    const row = mergeDmThread(decryptedRow, placeholderWithStatus).find((m) => m.id === "9")!;
    expect(row.content).toBe("m9");
    expect(row.status).toBe("failed");
  });
});

describe("DM thread loading gate", () => {
  it("settles a fresh cached empty thread when no initial pull is running", () => {
    // Reopening this cache entry within staleTime skips the queryFn. The old
    // sticky done-bit reset on mount and could therefore never become true.
    expect(shouldShowDmThreadLoading(false, 0, false)).toBe(false);
  });

  it("keeps a cold empty thread loading only while its first pull is running", () => {
    expect(shouldShowDmThreadLoading(false, 0, true)).toBe(true);
    expect(shouldShowDmThreadLoading(false, 0, false)).toBe(false);
  });

  it("paints local messages even while a superseded empty pull winds down", () => {
    expect(shouldShowDmThreadLoading(false, 1, true)).toBe(false);
  });
});

describe("buildThreadRows (viewport-bounded eager decryption)", () => {
  const SELF_PK = "a".repeat(64);
  const PEER_PK = "b".repeat(64);

  function dmEvt(id: string, createdAt: number, from = PEER_PK): NostrEvent {
    return {
      id: id.padEnd(64, "0").slice(0, 64),
      pubkey: from,
      created_at: createdAt,
      kind: 4,
      tags: [["p", SELF_PK]],
      content: `cipher-${id}`,
      sig: "f".repeat(128),
    };
  }

  const ok = async (_cp: string, ct: string) => `plain-${ct}`;

  it("decrypts only the newest `eager` messages; older are placeholders", async () => {
    const events = [dmEvt("1", 100), dmEvt("2", 200), dmEvt("3", 300), dmEvt("4", 400)];
    const decrypt = vi.fn(ok);

    // eager = 2 → only the two newest (400, 300) get decrypted.
    const rows = await buildThreadRows(events, SELF_PK, PEER_PK, decrypt, 2);

    expect(decrypt).toHaveBeenCalledTimes(2);
    // Returned oldest-first.
    expect(rows.map((r) => r.created_at)).toEqual([100, 200, 300, 400]);
    const byTime = Object.fromEntries(rows.map((r) => [r.created_at, r]));
    expect(byTime[100].encrypted).toBe(true);
    expect(byTime[200].encrypted).toBe(true);
    expect(byTime[300].encrypted).toBeUndefined();
    expect(byTime[300].content).toBe("plain-cipher-3");
    expect(byTime[400].encrypted).toBeUndefined();
  });

  it("eager = 0 makes every message a placeholder (no signer calls)", async () => {
    const events = [dmEvt("1", 100), dmEvt("2", 200)];
    const decrypt = vi.fn(ok);
    const rows = await buildThreadRows(events, SELF_PK, PEER_PK, decrypt, 0);
    expect(decrypt).not.toHaveBeenCalled();
    expect(rows.every((r) => r.encrypted)).toBe(true);
  });

  it("a decrypt failure on an eager message becomes a placeholder, not a drop", async () => {
    const events = [dmEvt("1", 100)];
    const decrypt = vi.fn(async () => {
      throw new Error("signer refused");
    });
    const rows = await buildThreadRows(events, SELF_PK, PEER_PK, decrypt, 10);
    expect(rows).toHaveLength(1); // not dropped
    expect(rows[0].encrypted).toBe(true);
    expect(rows[0].content).toBe("");
  });

  it("uses already-cached plaintext for OLD messages regardless of the eager window", async () => {
    // Revisiting a thread: an old message decrypted last time is in the memo, so
    // it must come back decrypted even though it's outside the eager window.
    const old = dmEvt("1", 100);
    const newer = dmEvt("2", 200);
    // Prime the memo as if "1" was decrypted earlier.
    setRenderedPlaintext(old.id, "remembered");

    const decrypt = vi.fn(ok);
    const rows = await buildThreadRows([old, newer], SELF_PK, PEER_PK, decrypt, 1);

    const byTime = Object.fromEntries(rows.map((r) => [r.created_at, r]));
    // "1" served from memo (no decrypt call for it); "2" decrypted eagerly.
    expect(byTime[100].content).toBe("remembered");
    expect(byTime[100].encrypted).toBeUndefined();
    expect(byTime[200].content).toBe("plain-cipher-2");
    expect(decrypt).toHaveBeenCalledTimes(1); // only "2"
  });
});

describe("buildThreadPlaceholders (instant first frame)", () => {
  const SELF_PK = "a".repeat(64);
  const PEER_PK = "b".repeat(64);

  function dmEvt(id: string, createdAt: number): NostrEvent {
    return {
      id: id.padEnd(64, "0").slice(0, 64),
      pubkey: PEER_PK,
      created_at: createdAt,
      kind: 4,
      tags: [["p", SELF_PK]],
      content: `cipher-${id}`,
      sig: "f".repeat(128),
    };
  }

  it("returns every event as a placeholder synchronously (no decryption)", () => {
    const rows = buildThreadPlaceholders([dmEvt("2", 200), dmEvt("1", 100)]);
    expect(rows.map((r) => r.created_at)).toEqual([100, 200]); // oldest-first
    expect(rows.every((r) => r.encrypted && r.content === "")).toBe(true);
  });

  it("fills in already-cached plaintext immediately (not a placeholder)", () => {
    const e = dmEvt("1", 100);
    setRenderedPlaintext(e.id, "already known");
    const [row] = buildThreadPlaceholders([e]);
    expect(row.encrypted).toBeUndefined();
    expect(row.content).toBe("already known");
  });
});

describe("decryptThreadRows (progressive streaming, concurrent)", () => {
  const SELF_PK = "a".repeat(64);
  const PEER_PK = "b".repeat(64);

  function dmEvt(id: string, createdAt: number): NostrEvent {
    return {
      id: id.padEnd(64, "0").slice(0, 64),
      pubkey: PEER_PK,
      created_at: createdAt,
      kind: 4,
      tags: [["p", SELF_PK]],
      content: `cipher-${id}`,
      sig: "f".repeat(128),
    };
  }
  const ok = async (_cp: string, ct: string) => `plain-${ct}`;

  it("streams each decrypted row via onRow (whole eager window)", async () => {
    const events = [dmEvt("1", 100), dmEvt("2", 200), dmEvt("3", 300)];
    const got: number[] = [];
    await decryptThreadRows(events, SELF_PK, PEER_PK, vi.fn(ok), 10, (row) => {
      got.push(row.created_at);
    });
    // Decrypts fire concurrently, so arrival order isn't guaranteed; assert the
    // full set is revealed.
    expect(got.sort()).toEqual([100, 200, 300]);
  });

  it("only streams the newest `eager` rows", async () => {
    const events = [dmEvt("1", 100), dmEvt("2", 200), dmEvt("3", 300)];
    const got: number[] = [];
    await decryptThreadRows(events, SELF_PK, PEER_PK, vi.fn(ok), 1, (row) => {
      got.push(row.created_at);
    });
    expect(got).toEqual([300]); // only the newest
  });

  it("skips messages already in the plaintext cache (no re-decrypt, no onRow)", async () => {
    const cached = dmEvt("1", 100);
    const fresh = dmEvt("2", 200);
    setRenderedPlaintext(cached.id, "known");
    const decrypt = vi.fn(ok);
    const got: number[] = [];
    await decryptThreadRows([cached, fresh], SELF_PK, PEER_PK, decrypt, 10, (row) => {
      got.push(row.created_at);
    });
    expect(decrypt).toHaveBeenCalledTimes(1); // only the fresh one
    expect(got).toEqual([200]);
  });

  it("a failed decrypt is skipped (no onRow) so the row stays a placeholder", async () => {
    const decrypt = vi.fn(async () => {
      throw new Error("refused");
    });
    const got: number[] = [];
    await decryptThreadRows([dmEvt("1", 100)], SELF_PK, PEER_PK, decrypt, 10, (row) => {
      got.push(row.created_at);
    });
    expect(got).toEqual([]); // nothing streamed; placeholder remains
  });
});

// Per-relay, per-direction pagination cursors. A single global `until` cursor
// can skip ranges across heterogeneous relays (a sparse relay returning much
// older events than a dense one); per-relay/per-direction cursors page each
// independently. `null` = exhausted, `undefined` = unknown/retryable (a failed
// relay is never marked exhausted).
describe("nextDirectionCursor", () => {
  function evts(count: number, oldest: number): NostrEvent[] {
    return Array.from({ length: count }, (_, i) =>
      dmEvent({ id: `e${i}`, from: PEER1, to: SELF, createdAt: oldest + i }),
    );
  }

  it("a short page (< page size) is exhausted → null", () => {
    expect(nextDirectionCursor(evts(3, 1000))).toBeNull();
  });

  it("an empty page is exhausted → null", () => {
    expect(nextDirectionCursor([])).toBeNull();
  });

  it("a full page advances to the oldest timestamp minus one", () => {
    const full = evts(DM_PAGE_SIZE, 5000); // timestamps 5000..5000+size-1
    expect(nextDirectionCursor(full)).toBe(4999);
  });
});

describe("hasMoreCursor", () => {
  it("false when every relay/direction is exhausted (null)", () => {
    const cursors: RelayCursors = {
      "wss://a": { sent: null, received: null },
      "wss://b": { sent: null, received: null },
    };
    expect(hasMoreCursor(cursors)).toBe(false);
  });

  it("true if any single direction still has pages (a number cursor)", () => {
    const cursors: RelayCursors = {
      "wss://a": { sent: null, received: null },
      "wss://b": { sent: 1234, received: null },
    };
    expect(hasMoreCursor(cursors)).toBe(true);
  });

  it("true if a relay is unknown/retryable (undefined), not exhausted", () => {
    // A relay that failed this pass is left undefined so the next pass retries
    // it — it must NOT count as exhausted.
    const cursors: RelayCursors = {
      "wss://a": { sent: null, received: null },
      "wss://b": { sent: undefined, received: undefined },
    };
    expect(hasMoreCursor(cursors)).toBe(true);
  });

  it("false for no relays", () => {
    expect(hasMoreCursor({})).toBe(false);
  });
});

describe("buildDmFilters", () => {
  const FOLLOWS = [PEER1, PEER2];

  it("first page (undefined cursor) queries both directions with no until", () => {
    const filters = buildDmFilters(SELF, undefined, FOLLOWS);
    expect(filters).toHaveLength(2);
    expect(filters[0]).toMatchObject({ kinds: [4], authors: [SELF], limit: DM_PAGE_SIZE });
    expect(filters[1]).toMatchObject({ kinds: [4], authors: FOLLOWS, "#p": [SELF], limit: DM_PAGE_SIZE });
    expect(filters[0].until).toBeUndefined();
    expect(filters[1].until).toBeUndefined();
  });

  it("a number cursor adds `until` for that direction", () => {
    const filters = buildDmFilters(SELF, { sent: 1000, received: 2000 }, FOLLOWS);
    expect(filters[0].until).toBe(1000);
    expect(filters[1].until).toBe(2000);
  });

  it("an exhausted direction (null) is omitted entirely", () => {
    const filters = buildDmFilters(SELF, { sent: null, received: 2000 }, FOLLOWS);
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({ authors: FOLLOWS, "#p": [SELF], until: 2000 });
  });

  it("both directions exhausted → no filters", () => {
    expect(buildDmFilters(SELF, { sent: null, received: null }, FOLLOWS)).toHaveLength(0);
  });

  it("no follows → received filter omitted (only the sent direction)", () => {
    const filters = buildDmFilters(SELF, undefined, []);
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({ kinds: [4], authors: [SELF] });
  });
});
