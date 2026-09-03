// @vitest-environment node
/**
 * Performance benchmark for the reads the always-mounted `ServerRail` drives —
 * the ones behind the "fine for new users, bad for power users" hitches — run
 * against BOTH engines a real build gets: `SqliteArmadaDB` (the desktop/native
 * engine, over the same `NodeSqlDriver` the conformance suite uses) and
 * `IndexedDBArmadaDB` (the web engine, over `fake-indexeddb`).
 *
 * WHY THIS EXISTS, ALONGSIDE THE CHARACTERIZATION TESTS
 *
 * `useCommunityRumors.railLoad.test.tsx` pins the SHAPE — that the rail issues
 * one interval-free read per community, and that no elapsed wall-clock adds a
 * further read now the backstop is gone. It counts crossings; it does not
 * measure what a crossing COSTS. This file measures the cost, in the units that
 * transfer from this process to a phone: rumors materialized out of storage and
 * statements/requests issued (`Work` below). Wall-clock is printed for the
 * record and is only trustworthy for SQLite — `fake-indexeddb` is a JS
 * reimplementation whose timings do not resemble a browser's.
 *
 * WHAT IT ASSERTS, AND WHY EACH NUMBER IS THE STORY
 *
 *   1. A single community's rail read splits into a WINDOW-bounded part and a
 *      HISTORY-linear part, and the benchmark measures both rather than assuming
 *      the first. `queryRumorsByChannel` issues, per channel, one filter over
 *      the timeline-ROW kinds (`CHAT_ROW_KINDS`, always dense) and one over the
 *      SIDE kinds (`CHAT_SIDE_KINDS` — deletes/reactions/edits). The row filter
 *      fills its 200-row budget near the head and stops, so it is window-bounded
 *      and does not grow with a channel's depth. The side filter does NOT: it
 *      walks a channel newest-first until it collects 200 side events, so a
 *      channel with fewer than 200 lifetime side events is scanned to its floor.
 *      On IndexedDB (web) this shows up directly as rows materialized; on SQLite
 *      the same scan happens inside the engine but is invisible to a
 *      rows-returned counter. This is a SEPARATE lever from the interval removal
 *      — a per-read cost worth its own fix (a composite `(channel,kind)` index,
 *      or a depth cap on the side budget) — surfaced here because measuring is
 *      how it was found.
 *
 *   2. A FULL rail sweep is linear in community count — sweeping 8 communities
 *      costs exactly twice sweeping 4. This is the recurring work the removed
 *      `refetchInterval` backstop paid on EVERY tick, for every joined
 *      community, whatever screen was open. The absolute figure is printed as
 *      "this is what a power user paid per interval".
 *
 *   3. The event-driven delta the bus drives — re-reading only the ONE channel a
 *      message arrived in — is a small fraction of a full sweep (< sweep / N).
 *      This is what the fix replaced the periodic O(communities × channels)
 *      scan with: an O(1) read per message burst. The ratio is the payoff.
 *
 *   4. The mentions read (the old 30s poll, the highest-frequency rail load) is
 *      bounded by its `#p` index, not the corpus depth.
 *
 * The corpus is deliberately IDENTICAL per community so #2's halving is exact
 * rather than approximate — the point is the linear factor, not the skew, which
 * the DM benchmark already covers.
 */
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { IndexedDBArmadaDB } from "@/lib/db/IndexedDBArmadaDB";
import { NodeSqlDriver } from "@/lib/db/nodeSqlDriver";
import { SqliteArmadaDB } from "@/lib/db/SqliteArmadaDB";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "@/lib/db/driver";
import type { ArmadaDB } from "@/lib/db/types";

// ── Redirect rumorStore's store accessor to the engine under test ────────────
//
// `queryRumorsByChannel` / `queryMentionRumors` reach the store through
// `getArmadaDB()`; the mock hands them the backend this describe.each is on.
// `ARMADA_TENANTS` is provided because rumorStore reads `c2Park` at module load.

let current: ArmadaDB | undefined;

vi.mock("@/lib/db/armadaDB", () => ({
  getArmadaDB: () => current!,
  ARMADA_TENANTS: { main: "main", c2Park: "c2park", serviceQueue: "svc" },
}));

const { queryRumorsByChannel, queryMentionRumors, communityTenant } = await import(
  "@/concord/lib/rumorStore"
);

// ── Corpus ───────────────────────────────────────────────────────────────────

/** A timeline ROW (`CHAT_ROW_KINDS`): fills the row filter's window budget. */
const KIND_MESSAGE = 9;
/**
 * A SIDE event (`CHAT_SIDE_KINDS`): a reaction. Kept sparse relative to the
 * 200-event side budget on purpose — a real channel accrues far fewer reactions
 * than messages — so the side filter's floor scan (header point 1) is exercised
 * rather than hidden behind a budget that fills near the head.
 */
const KIND_REACTION = 7;

/**
 * The two kind-sets `queryRumorsByChannel` issues a filter over, per channel —
 * mirrored from `rumorStore.ts` (`CHAT_ROW_KINDS` is exported; `CHAT_SIDE_KINDS`
 * is module-private, transcribed here with the same comment style the DM
 * benchmark uses for `DM_RUMOR_KINDS`). Test 1 drives each apart to measure the
 * row filter's window bound and the side filter's floor scan separately.
 */
const CHAT_ROW_KINDS = [9, 1068, 1111, 1740, 31922, 31923];
const CHAT_SIDE_KINDS = [5, 7, 1018, 3302, 8333, 9735, 31925];

/** A deterministic 64-char lowercase-hex id from a label (FNV-1a, widened). */
function hex(label: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < label.length; j++) {
      h ^= label.charCodeAt(j) + i;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(h.toString(16).padStart(8, "0"));
  }
  return out.join("").slice(0, 64);
}

const SELF = hex("self");

/** How many communities a power user is in, and how many the halving compares. */
const COMMUNITIES = 8;
const HALF = COMMUNITIES / 2;

/**
 * Each community's channels, by message count — IDENTICAL across communities so
 * a k-community sweep costs exactly k times a one-community sweep. The first is
 * far past `PER_CHANNEL`, which is what makes "window, not history" measurable.
 */
const CHANNEL_SIZES = [600, 300, 150, 90, 60, 40];

/** The rail read's per-channel window (`useCommunityRumors.ts`: `PER_CHANNEL`). */
const PER_CHANNEL = 200;

/** The mentions read's limit (`useConcordMentions.ts`: `MENTION_LIMIT`). */
const MENTION_LIMIT = 200;

/** One in this many messages p-tags the viewer, so the mentions read has prey. */
const MENTION_EVERY = 10;

/**
 * One reaction per this many messages — a SIDE event, sparse relative to rows
 * (a real channel accrues far fewer reactions than messages). Sparse on
 * purpose: fewer than the 200-event side budget per channel, so the side
 * filter's floor scan (header point 1) is what the read actually pays, exactly
 * as it does in the field.
 */
const REACTION_EVERY = 5;

/** Rumors written per burst, as `writeRumors` commits a sync page. */
const BURST = 200;

const communityIds = Array.from({ length: COMMUNITIES }, (_, i) => hex(`community-${i}`));
const channelIdsOf = (communityIdHex: string) =>
  CHANNEL_SIZES.map((_, c) => hex(`${communityIdHex}:channel-${c}`));

/** Message (ROW) rumors a single community holds — the row filter's prey. */
const COMMUNITY_ROWS = CHANNEL_SIZES.reduce((n, s) => n + s, 0);
/** Reaction (SIDE) rumors a single community holds — sparse, under the budget. */
const COMMUNITY_SIDE = CHANNEL_SIZES.reduce((n, s) => n + Math.floor(s / REACTION_EVERY), 0);
/** Every rumor a single community holds — the floor a side floor-scan reaches. */
const COMMUNITY_DEPTH = COMMUNITY_ROWS + COMMUNITY_SIDE;
/** The window a row read is bounded by: min(depth, 200) rows summed per channel. */
const COMMUNITY_WINDOW = CHANNEL_SIZES.reduce((n, s) => n + Math.min(s, PER_CHANNEL), 0);

let rumorSeq = 0;

/**
 * One community's rumors, in arrival order per channel: mostly messages (ROW
 * kinds), a sparse reaction (SIDE kind) every {@link REACTION_EVERY}, some
 * messages p-tagging the viewer. This is the shape the rail's read walks — the
 * two filters `queryRumorsByChannel` issues land on the row kinds and the side
 * kinds respectively.
 */
function communityRumors(communityIdHex: string): NostrRumor[] {
  const out: NostrRumor[] = [];
  const channels = channelIdsOf(communityIdHex);
  let clock = 1_700_000_000;
  channels.forEach((channelIdHex, c) => {
    for (let i = 0; i < CHANNEL_SIZES[c]; i++) {
      const tags: string[][] = [
        ["channel", channelIdHex],
        ["epoch", "0"],
      ];
      // A mention every few messages: a real kind-9 that the `#p` index picks
      // out, which is what the mentions read costs are measured against.
      if (i % MENTION_EVERY === MENTION_EVERY - 1) tags.push(["p", SELF]);
      out.push({
        id: `r${String(++rumorSeq).padStart(9, "0")}`,
        pubkey: hex(`author-${i % 5}`),
        kind: KIND_MESSAGE,
        created_at: clock++,
        content: `message ${i} in channel ${c}`,
        tags,
      });
      // A reaction to the message just posted — a SIDE event under its own
      // budget in the read. Sparse, so the side filter never fills 200 and
      // scans the channel to its floor.
      if (i % REACTION_EVERY === REACTION_EVERY - 1) {
        out.push({
          id: `s${String(++rumorSeq).padStart(9, "0")}`,
          pubkey: hex(`author-${(i + 1) % 5}`),
          kind: KIND_REACTION,
          created_at: clock++,
          content: "+",
          tags: [["channel", channelIdHex], ["epoch", "0"], ["e", `r${String(rumorSeq - 1).padStart(9, "0")}`]],
        });
      }
    }
  });
  return out;
}

// ── Work counters (units that mean the same in a browser as here) ────────────

interface Work {
  requests: number;
  rows: number;
}

const work: Work = { requests: 0, rows: 0 };
const resetWork = () => {
  work.requests = 0;
  work.rows = 0;
};

/** Count every IndexedDB request and every row it materializes. */
function instrumentIndexedDB(): () => void {
  const restores: Array<() => void> = [];
  const g = globalThis as unknown as Record<string, { prototype: Record<string, unknown> }>;

  const patch = (holder: string, method: string, rows: (result: unknown) => number) => {
    const proto = g[holder]?.prototype;
    const original = proto?.[method] as ((...a: unknown[]) => unknown) | undefined;
    if (!proto || typeof original !== "function") return;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      work.requests++;
      const request = original.apply(this, args) as {
        addEventListener?: (t: string, f: () => void) => void;
        result?: unknown;
      };
      request?.addEventListener?.("success", () => {
        work.rows += rows(request.result);
      });
      return request;
    };
    restores.push(() => {
      proto[method] = original;
    });
  };

  const many = (result: unknown) => (Array.isArray(result) ? result.length : 0);
  const one = (result: unknown) => (result === undefined || result === null ? 0 : 1);

  for (const holder of ["IDBObjectStore", "IDBIndex"]) {
    patch(holder, "getAll", many);
    patch(holder, "getAllKeys", many);
    patch(holder, "get", one);
    patch(holder, "getKey", one);
    patch(holder, "count", () => 0);
    patch(holder, "openCursor", one);
    patch(holder, "openKeyCursor", () => 0);
  }
  patch("IDBObjectStore", "put", () => 0);
  patch("IDBObjectStore", "add", () => 0);
  patch("IDBObjectStore", "delete", () => 0);

  const cursorProto = g.IDBCursor?.prototype;
  for (const method of ["continue", "continuePrimaryKey", "advance"]) {
    const original = cursorProto?.[method] as ((...a: unknown[]) => unknown) | undefined;
    if (!cursorProto || typeof original !== "function") continue;
    cursorProto[method] = function (this: unknown, ...args: unknown[]) {
      work.requests++;
      return original.apply(this, args);
    };
    restores.push(() => {
      cursorProto[method] = original;
    });
  }

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

/** The same counters over the SQL driver: statements run and rows returned. */
class CountingSqlDriver implements ArmadaSqlDriver {
  constructor(private readonly inner: NodeSqlDriver) {}

  run(sql: string, params: SqlValue[] = []): void {
    work.requests++;
    this.inner.run(sql, params);
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    work.requests++;
    const rows = this.inner.all(sql, params);
    work.rows += rows.length;
    return rows;
  }

  close(): void {
    this.inner.close();
  }
}

// ── Timing ───────────────────────────────────────────────────────────────────

interface Measurement {
  median: number;
  work: Work;
}

/** Run `fn` once warm, then `runs` times; report the median and one run's work. */
async function measure(runs: number, fn: () => Promise<unknown>): Promise<Measurement> {
  await fn();
  resetWork();
  await fn();
  const cost = { ...work };
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], work: cost };
}

const show = (m: Measurement) =>
  `${m.median.toFixed(2)}ms, ${m.work.requests} requests, ${m.work.rows} rows read`;

// ── Reads under test (the real rail-driven functions) ────────────────────────

/** One full rail sweep: `useCommunityRumors`' read, once per community. */
async function railSweep(ids: string[]): Promise<void> {
  for (const id of ids) {
    await queryRumorsByChannel(id, channelIdsOf(id), { perChannel: PER_CHANNEL });
  }
}

/** The bus-driven delta: re-read the ONE channel a message just landed in. */
async function delta(communityIdHex: string, channelIdHex: string): Promise<void> {
  await queryRumorsByChannel(communityIdHex, [channelIdHex], { perChannel: PER_CHANNEL });
}

// ── Backends ─────────────────────────────────────────────────────────────────

interface Backend {
  name: string;
  create(): { db: ArmadaDB & { close(): Promise<void> }; stop: () => void };
}

let dbSeq = 0;

const backends: Backend[] = [
  {
    name: "SqliteArmadaDB",
    create() {
      const db = new SqliteArmadaDB(new CountingSqlDriver(new NodeSqlDriver()));
      return { db, stop: () => {} };
    },
  },
  {
    name: "IndexedDBArmadaDB",
    create() {
      (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      const stop = instrumentIndexedDB();
      return { db: new IndexedDBArmadaDB(`armada-rail-perf-${++dbSeq}`), stop };
    },
  },
];

describe.each(backends)("$name — rail-driven read cost", ({ name, create }) => {
  let db: ArmadaDB & { close(): Promise<void> };
  let stop: () => void;

  beforeAll(async () => {
    ({ db, stop } = create());
    current = db;

    resetWork();
    const t0 = performance.now();
    let total = 0;
    for (const id of communityIds) {
      const store = db.tenant(communityTenant(id));
      const rumors = communityRumors(id);
      total += rumors.length;
      for (let i = 0; i < rumors.length; i += BURST) {
        await Promise.all(rumors.slice(i, i + BURST).map((r) => store.event(r)));
      }
    }
    const elapsed = performance.now() - t0;
    console.log(
      `[perf][${name}] ingest: ${total} rumors / ${COMMUNITIES} communities × ` +
        `${CHANNEL_SIZES.length} channels in bursts of ${BURST}: ${elapsed.toFixed(0)}ms ` +
        `(${((elapsed / total) * 1000).toFixed(0)}µs each)`,
    );
  }, 900_000);

  afterAll(async () => {
    stop();
    await db.close();
    current = undefined;
  });

  it("splits into a window-bounded row read and a floor-scanning side read", { timeout: 300_000 }, async () => {
    const id = communityIds[0];
    const channels = channelIdsOf(id);
    const store = db.tenant(communityTenant(id));

    // The two filters `queryRumorsByChannel` issues, measured APART, so the
    // window-bounded half and the history-linear half are visible separately
    // rather than summed into one number that hides which is which.
    const rowRead = await measure(3, () =>
      store.query(channels.map((c) => ({ kinds: CHAT_ROW_KINDS, "#channel": [c], limit: PER_CHANNEL }))));
    const sideRead = await measure(3, () =>
      store.query(channels.map((c) => ({ kinds: CHAT_SIDE_KINDS, "#channel": [c], limit: PER_CHANNEL }))));
    const whole = await measure(3, () => railSweep([id]));

    console.log(
      `[perf][${name}] one community (${COMMUNITY_ROWS} msgs + ${COMMUNITY_SIDE} reactions ` +
        `= ${COMMUNITY_DEPTH} deep, ${CHANNEL_SIZES.length} channels, ${CHANNEL_SIZES[0]}-msg busiest):\n` +
        `    row filter  ${show(rowRead)}  (window ≈ ${COMMUNITY_WINDOW})\n` +
        `    side filter ${show(sideRead)}  (depth = ${COMMUNITY_DEPTH})\n` +
        `    whole read  ${show(whole)}`,
    );

    // The ROW filter is window-bounded on BOTH engines: it fills its 200-row
    // budget near each channel's head and stops, so its cost is the window sum,
    // not the history. This is the half that behaves.
    expect(rowRead.work.rows).toBeLessThan(COMMUNITY_WINDOW * 2);

    // The SIDE filter is NOT: fewer than 200 reactions exist per channel, so it
    // walks each channel to its FLOOR looking for a budget it never fills. That
    // scan is only VISIBLE to a rows-materialized counter on IndexedDB — SQLite
    // does the same walk inside the b-tree and reports only the rows it
    // returned — so the assertion that proves the floor scan is web-only. This
    // is a SEPARATE lever from the interval removal: a per-read cost that a
    // composite `(channel,kind)` index or a depth-capped side budget would fix.
    if (name === "IndexedDBArmadaDB") {
      expect(sideRead.work.rows).toBeGreaterThan(COMMUNITY_WINDOW * 1.5);
      // The side floor scan, not the row window, is what dominates the read.
      expect(sideRead.work.rows).toBeGreaterThan(rowRead.work.rows);
    }
  });

  it("charges a full rail sweep linearly in community count", { timeout: 300_000 }, async () => {
    const half = await measure(2, () => railSweep(communityIds.slice(0, HALF)));
    const full = await measure(2, () => railSweep(communityIds));

    console.log(
      `[perf][${name}] rail sweep — ${HALF} communities ${show(half)} | ` +
        `${COMMUNITIES} communities ${show(full)}  ` +
        `← the recurring work the removed backstop paid PER interval`,
    );

    // The whole point of "bad for power users": the recurring load is linear in
    // membership. Doubling the communities doubles the sweep, near-exactly,
    // because every community's corpus is identical here.
    expect(full.work.rows).toBeGreaterThan(half.work.rows * 1.8);
    expect(full.work.rows).toBeLessThan(half.work.rows * 2.2);
  });

  it("re-reads one channel for a fraction of a full sweep", { timeout: 300_000 }, async () => {
    const full = await measure(2, () => railSweep(communityIds));
    const busiest = channelIdsOf(communityIds[0])[0];
    const one = await measure(3, () => delta(communityIds[0], busiest));

    console.log(
      `[perf][${name}] event-driven delta (one channel) ${show(one)} | ` +
        `full sweep ${show(full)}  ` +
        `← the bus path that replaced the periodic sweep`,
    );

    // Removing the backstop replaced an O(communities × channels) periodic scan
    // with this: a single changed channel's read on a message burst. It must be
    // a small fraction of a whole sweep — well under one community's share.
    expect(one.work.rows).toBeLessThan(full.work.rows / COMMUNITIES);
  });

  it("bounds the mentions read by its index, not the corpus", { timeout: 300_000 }, async () => {
    const id = communityIds[0];
    const channels = channelIdsOf(id);
    const mentions = await measure(3, async () => {
      const rows = await queryMentionRumors(id, channels, SELF, { limit: MENTION_LIMIT });
      // Every 10th message p-tags self, capped at the read limit.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(MENTION_LIMIT);
    });

    console.log(
      `[perf][${name}] mentions read (limit ${MENTION_LIMIT}, ${COMMUNITY_DEPTH}-rumor community): ` +
        show(mentions),
    );

    // The `#p` filter is index-backed: the read reaches its mentions directly,
    // not by scanning the community. Cost tracks the mentions, not the corpus.
    expect(mentions.work.rows).toBeLessThan(COMMUNITY_DEPTH);
  });
});
