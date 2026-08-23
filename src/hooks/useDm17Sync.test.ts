import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { dm17InboxFilter, queryWrapsPerRelay, relayScanWatermarks, syncDm17Inbox } from "@/hooks/useDm17";
import { readDm17Cursor, updateDm17Cursor } from "@/lib/nip17/dm17Store";
import { MAX_WRAP_BACKDATE_SECS } from "@/lib/nip17/protocol";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

// Mirrors of useDm17's module-private slack constants.
const RESYNC_SLACK_SECS = MAX_WRAP_BACKDATE_SECS + 3600;
const NARROW_RESYNC_SLACK_SECS = 10 * 60;

const event = (id: string, createdAt: number): NostrEvent => ({
  id: id.padEnd(64, "0"),
  pubkey: "1".repeat(64),
  created_at: createdAt,
  kind: 1059,
  tags: [["p", "2".repeat(64)]],
  content: "ciphertext",
  sig: "3".repeat(128),
});

describe("NIP-17 per-relay inbox queries", () => {
  it("keeps successful empty relays distinct from failed relays", async () => {
    const fastQuery = vi.fn().mockResolvedValue([]);
    const slowQuery = vi.fn().mockRejectedValue(new Error("timeout"));
    const nostr = {
      relay: (url: string) => ({ query: url.includes("fast") ? fastQuery : slowQuery }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://fast.example", "wss://slow.example"],
      { kinds: [1059], "#p": ["2".repeat(64)] },
      new AbortController().signal,
    );

    expect(result.pages).toEqual([{ url: "wss://fast.example", events: [] }]);
    expect(result.failed).toEqual(["wss://slow.example"]);
  });

  it("reports no successful pages when every relay fails", async () => {
    const nostr = {
      relay: () => ({ query: vi.fn().mockRejectedValue(new Error("offline")) }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://one.example", "wss://two.example"],
      { kinds: [1059] },
      new AbortController().signal,
    );

    expect(result.pages).toEqual([]);
    expect(result.failed).toEqual(["wss://one.example", "wss://two.example"]);
  });

  it("returns each relay's events without collapsing relay provenance", async () => {
    const first = event("a", 100);
    const second = event("b", 200);
    const nostr = {
      relay: (url: string) => ({
        query: vi.fn().mockResolvedValue(url.includes("one") ? [first] : [second]),
      }),
    };

    const result = await queryWrapsPerRelay(
      nostr as never,
      ["wss://one.example", "wss://two.example"],
      (url) => ({ kinds: [1059], since: url.includes("one") ? 10 : 20 }),
      new AbortController().signal,
    );

    expect(result.pages).toEqual([
      { url: "wss://one.example", events: [first] },
      { url: "wss://two.example", events: [second] },
    ]);
  });
});

describe("NIP-17 per-relay inbox filters", () => {
  const self = "2".repeat(64);

  it("does not inherit a legacy global cursor for an unscanned relay", () => {
    const filter = dm17InboxFilter(
      self,
      { newest: 50_000, oldest: 1, exhausted: false },
      "wss://new.example",
      false,
    );

    // Returns an array: [wrapFilter, peerSignalFilter] — check the wrap filter
    expect(filter[0].since).toBeUndefined();
  });

  it("uses each relay's own cursor for narrow and full recovery windows", () => {
    const cursor = {
      newest: 50_000,
      oldest: 1,
      exhausted: false,
      relayNewest: {
        "wss://fast.example": 50_000,
        "wss://slow.example": 40_000,
      },
    };

    expect(dm17InboxFilter(self, cursor, "wss://fast.example", false)[0].since).toBe(49_400);
    expect(dm17InboxFilter(self, cursor, "wss://slow.example", false)[0].since).toBe(39_400);
    expect(dm17InboxFilter(self, cursor, "wss://fast.example", true)[0].since).toBe(0);
  });
});

describe("relayScanWatermarks", () => {
  const nowSecs = 100 * MAX_WRAP_BACKDATE_SECS;
  const floor = nowSecs - MAX_WRAP_BACKDATE_SECS;

  it("advances an empty page to the backdate floor, never to wall clock", () => {
    expect(relayScanWatermarks([{ url: "wss://a.example", events: [] }], nowSecs))
      .toEqual({ "wss://a.example": floor });
  });

  it("raises to the newest wrap when the page outruns the floor", () => {
    const pages = [{ url: "wss://a.example", events: [event("a", floor + 500), event("b", floor + 100)] }];
    expect(relayScanWatermarks(pages, nowSecs)["wss://a.example"]).toBe(floor + 500);
  });

  it("never leaves the watermark below the floor on a page of old wraps", () => {
    const pages = [{ url: "wss://a.example", events: [event("a", floor - 5_000)] }];
    expect(relayScanWatermarks(pages, nowSecs)["wss://a.example"]).toBe(floor);
  });
});

// ── syncDm17Inbox against a controllable pool ────────────────────────────────

interface PendingQuery {
  filter: NostrFilter;
  resolve: (events: NostrEvent[]) => void;
  reject: (error: unknown) => void;
}

/** A pool whose per-relay queries stay pending until the test settles them. */
function deferredPool() {
  const queries: PendingQuery[] = [];
  const pool = {
    relay: () => ({
      query: (filters: NostrFilter[]) =>
        new Promise<NostrEvent[]>((resolve, reject) => {
          queries.push({ filter: filters[0], resolve, reject });
        }),
    }),
  };
  return { pool, queries };
}

function syncCtx(pool: unknown, self: string, relays: string[]) {
  return {
    nostr: pool as never,
    signer: { nip44: {} } as never,
    self,
    method: undefined,
    relays,
  };
}

describe("syncDm17Inbox", () => {
  it("seeds an empty first scan's watermark at the backdate floor so the next poll still covers backdated wraps", async () => {
    const self = getPublicKey(generateSecretKey());
    const url = "wss://quiet.example";
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, [url]);

    const before = Math.floor(Date.now() / 1000);
    const pass = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(1));
    // No cursor yet: the first scan is unbounded.
    expect(queries[0].filter.since).toBeUndefined();
    queries[0].resolve([]);
    await expect(pass).resolves.toBe(true);
    const after = Math.floor(Date.now() / 1000);

    const cursor = await readDm17Cursor(self);
    const watermark = cursor?.relayNewest?.[url];
    expect(watermark).toBeGreaterThanOrEqual(before - MAX_WRAP_BACKDATE_SECS);
    expect(watermark).toBeLessThanOrEqual(after - MAX_WRAP_BACKDATE_SECS);
    // A wrap published a moment later, backdated the full two days, is inside
    // the next narrow poll's window.
    const since = dm17InboxFilter(self, cursor, url, false)[0].since;
    expect(since).toBeLessThanOrEqual(after - MAX_WRAP_BACKDATE_SECS);
  });

  it("prunes the persisted watermark of a relay no longer in the sync set", async () => {
    const self = getPublicKey(generateSecretKey());
    const url = "wss://kept.example";
    await updateDm17Cursor(self, {
      newest: 100,
      oldest: 50,
      exhausted: false,
      relayNewest: { [url]: 100, "wss://removed.example": 90 },
    });
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, [url]);

    const pass = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(1));
    queries[0].resolve([]);
    await expect(pass).resolves.toBe(true);

    const cursor = await readDm17Cursor(self);
    expect(cursor?.relayNewest?.["wss://removed.example"]).toBeUndefined();
    expect(cursor?.relayNewest?.[url]).toBeGreaterThanOrEqual(100);
  });

  it("runs a full recovery queued behind an in-flight narrow pass exactly once", async () => {
    const self = getPublicKey(generateSecretKey());
    const url = "wss://dm.example";
    // A far-future watermark so the real clock's backdate floor cannot
    // overtake it, making narrow vs full windows distinguishable.
    const newest = 5_000_000_000;
    await updateDm17Cursor(self, {
      newest,
      oldest: 1,
      exhausted: false,
      relayNewest: { [url]: newest },
    });
    const { pool, queries } = deferredPool();
    const ctx = syncCtx(pool, self, [url]);

    // First pass of the session pays the full window by cadence.
    const a = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(1));
    expect(queries[0].filter.since).toBe(newest - RESYNC_SLACK_SECS);
    queries[0].resolve([]);
    await expect(a).resolves.toBe(true);

    // A routine narrow poll, left in flight.
    const b = syncDm17Inbox(ctx, { force: true });
    await vi.waitFor(() => expect(queries.length).toBe(2));
    expect(queries[1].filter.since).toBe(newest - NARROW_RESYNC_SLACK_SECS);

    // A resume recovery arrives while the narrow pass is in flight: it must
    // let that pass finish, then pay the full window in a NEW pass.
    const c = syncDm17Inbox(ctx, { full: true });
    queries[1].resolve([]);
    await expect(b).resolves.toBe(true);
    await vi.waitFor(() => expect(queries.length).toBe(3));
    expect(queries[2].filter.since).toBe(newest - RESYNC_SLACK_SECS);

    // Another full caller while the full pass is in flight coalesces onto it
    // rather than paying the window again.
    const d = syncDm17Inbox(ctx, { full: true });
    queries[2].resolve([]);
    await expect(c).resolves.toBe(true);
    await expect(d).resolves.toBe(true);
    expect(queries.length).toBe(3);
  });
});
