// @vitest-environment node
/**
 * Performance guard for the NIP-17 read paths, against BOTH engines a browser
 * can get: `IndexedDBArmadaDB` (fake-indexeddb) and `SqliteArmadaDB` (real
 * SQLite through the same `NodeSqlDriver` the desktop shell ships, which is
 * also the reference the Kotlin and Swift ports are held to).
 *
 * These are the reads the derived term index was added for, and they are
 * measured together because they trade against each other: a thread read is a
 * seek down ONE term, the conversation list is a collapse over a whole
 * NAMESPACE, and an index shaped for one can make the other a scan.
 *
 * WHAT IS ASSERTED, AND WHY IT IS MOSTLY NOT WALL-CLOCK
 *
 * Wall-clock here is only trustworthy for SQLite. `fake-indexeddb` is a
 * JavaScript reimplementation whose costs do not resemble a browser's — most
 * sharply, `cursor.continue(key)` on a `prev` cursor is a LINEAR scan from the
 * top of the range (its `makeKeyRange` takes the max of the range's upper bound
 * and the sought key), where every real implementation seeks. A loose index
 * scan therefore looks quadratic in the fake and is logarithmic in Chrome, so
 * optimizing the adapter against the fake's clock would optimize the wrong
 * engine.
 *
 * What transfers is WORK VOLUME, so that is what the assertions pin: IndexedDB
 * requests issued and rumors materialized (`opCounts` below), and for SQLite
 * the statements run. A read that returns 100 rows out of a 4000-message
 * conversation must not deserialize 4000 rows to do it — true on every engine,
 * measurable on both, and the shape of every regression this file exists to
 * catch. Timings are printed alongside, for the record and for SQLite.
 */
import { IDBFactory } from "fake-indexeddb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IndexedDBArmadaDB } from "./IndexedDBArmadaDB";
import { NodeSqlDriver } from "./nodeSqlDriver";
import { SqliteArmadaDB } from "./SqliteArmadaDB";
import { tenantOptsFor } from "./termPolicies";

import { DM_MINE_TERM, DM_MSG_TERM, dmConvTerm } from "@/lib/nip17/conversation";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";
import type { ArmadaDB, NRumorStore } from "./types";

// ── The corpus ───────────────────────────────────────────────────────────────

const KIND_CHAT = 14;
const KIND_FILE = 15;
const KIND_REACTION = 7;
const KIND_TIMER = 1740;
const DM_RUMOR_KINDS = [KIND_CHAT, KIND_FILE, KIND_REACTION, 5, KIND_TIMER];

/** A deterministic 64-char hex pubkey from a label. */
function pk(label: string): string {
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

const SELF = pk("self");
const TENANT = `dm17:${SELF}`;

/**
 * A conversation: its participants, and how many messages it holds.
 *
 * Skewed on purpose. Real inboxes are not uniform — a few threads carry most of
 * the messages — and a uniform corpus hides exactly the bug the conversation
 * list had, a busy thread crowding every quiet one out of a windowed read. It
 * is also the only way to tell a seek from a scan: on a flat corpus they cost
 * the same.
 */
interface Conversation {
  peers: string[];
  messages: number;
}

const CONVERSATIONS: Conversation[] = [
  ...Array.from({ length: 14 }, (_, i) => ({
    peers: [pk(`peer-${i}`)],
    messages: Math.max(4, Math.round(300 / (i + 1))),
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    peers: [pk(`peer-${i}`), pk(`peer-${i + 20}`)].sort(),
    messages: 30,
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    peers: [pk(`peer-${i}`), pk(`peer-${i + 10}`), pk(`peer-${i + 20}`)].sort(),
    messages: 20,
  })),
];

/** The busiest thread, a middling one, and the quietest — the three cases. */
const BUSIEST = CONVERSATIONS[0];
const MIDDLING = CONVERSATIONS[3];
const QUIETEST = CONVERSATIONS[13];

/** Rumors per thread page, as `useDm17Thread` reads them. */
const PAGE = 50;

/** Rumors written per burst — one sync page, as `writeDm17Rumors` writes it. */
const BURST = 200;

let rumorSeq = 0;

/** One conversation's rumors, oldest first. */
function* conversationRumors(conv: Conversation, clock: () => number): Generator<NostrRumor> {
  const participants = [SELF, ...conv.peers];
  for (let i = 0; i < conv.messages; i++) {
    const author = participants[i % participants.length];
    const others = participants.filter((p) => p !== author);
    const tags = (others.length > 0 ? others : [author]).map((p) => ["p", p]);
    yield {
      id: `r${String(++rumorSeq).padStart(8, "0")}`,
      pubkey: author,
      kind: i % 17 === 0 ? KIND_FILE : KIND_CHAT,
      created_at: clock(),
      content: `message ${i} in a ${conv.peers.length}-party thread`,
      tags,
    };
    // A reaction every few messages: a rumor IN the conversation that is not a
    // message, which is what `convmsg:` exists to keep out of the list.
    if (i % 5 === 4) {
      yield {
        id: `r${String(++rumorSeq).padStart(8, "0")}`,
        pubkey: participants[(i + 1) % participants.length],
        kind: KIND_REACTION,
        created_at: clock(),
        content: "+",
        tags: [...tags, ["e", `r${String(rumorSeq - 1).padStart(8, "0")}`]],
      };
    }
  }
}

/**
 * The whole corpus, interleaved across conversations in time.
 *
 * Interleaving is what makes it a fair test. Written thread by thread, every
 * conversation's rumors would be contiguous in insertion order and a scan would
 * find a page of one immediately; arrival order spreads a thread across the
 * whole tenant, which is the order an unindexed read is expensive in.
 */
function allRumors(): NostrRumor[] {
  let now = 1_700_000_000;
  const clock = () => now++;
  const streams = CONVERSATIONS.map((c) => conversationRumors(c, clock));
  const out: NostrRumor[] = [];
  for (let live = true; live; ) {
    live = false;
    for (const stream of streams) {
      const next = stream.next();
      if (!next.done) {
        out.push(next.value);
        live = true;
      }
    }
  }
  // A timer per conversation, older than every message in it — the row a timer
  // read has to reach past a whole thread to find.
  const timers: NostrRumor[] = CONVERSATIONS.map((conv, i) => ({
    id: `t${String(i).padStart(8, "0")}`,
    pubkey: conv.peers[0],
    kind: KIND_TIMER,
    created_at: 1_699_000_000 + i,
    content: "",
    tags: [["p", SELF], ...conv.peers.slice(1).map((p) => ["p", p]), ["timer", "86400"]],
  }));
  return [...timers, ...out];
}

const RUMORS = allRumors();

// ── Work counters ────────────────────────────────────────────────────────────

/**
 * What one operation cost the engine underneath, in units that mean the same
 * thing in a browser as in this process.
 *
 * `requests` is IndexedDB requests issued (a cursor step is one) or SQL
 * statements run; `rows` is rumors the engine materialized out of storage,
 * whether or not the caller was given them. The second is the one that catches
 * an over-select: a filter answered by reading a whole conversation and
 * discarding most of it reports a hundred rows returned and thousands read.
 */
interface Work {
  requests: number;
  rows: number;
}

const work: Work = { requests: 0, rows: 0 };

function resetWork(): void {
  work.requests = 0;
  work.rows = 0;
}

/** Count every IndexedDB request and every row it hands back. */
function instrumentIndexedDB(): () => void {
  const restores: Array<() => void> = [];
  const g = globalThis as unknown as Record<string, { prototype: Record<string, unknown> }>;

  const patch = (holder: string, method: string, rows: (result: unknown) => number) => {
    const proto = g[holder]?.prototype;
    const original = proto?.[method] as ((...a: unknown[]) => unknown) | undefined;
    if (!proto || typeof original !== "function") return;
    proto[method] = function (this: unknown, ...args: unknown[]) {
      work.requests++;
      const request = original.apply(this, args) as { addEventListener?: (t: string, f: () => void) => void; result?: unknown };
      // An IDBRequest reports what it produced only once it succeeds.
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
    // A cursor request fires `success` once per POSITION — the open and every
    // step share it — so this one listener counts every row a walk
    // materializes, and `continue` below only counts the request.
    patch(holder, "openCursor", one);
    patch(holder, "openKeyCursor", () => 0);
  }
  patch("IDBObjectStore", "put", () => 0);
  patch("IDBObjectStore", "add", () => 0);
  patch("IDBObjectStore", "delete", () => 0);

  // A step re-uses the cursor's own request rather than making a new one, so
  // it is counted here and its row by that request's `success` listener above.
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

/** The same counters, over the SQL driver: statements run and rows returned. */
class CountingSqlDriver implements ArmadaSqlDriver {
  constructor(private readonly inner: NodeSqlDriver) {}

  run(sql: string, params: SqlValue[] = []): void {
    work.requests++;
    this.inner.run(sql, params);
  }

  all(sql: string, params: SqlValue[] = []): SqlRow[] {
    work.requests++;
    const rows = this.inner.all(sql, params);
    // Rows the engine read out of storage. A planner that narrows in SQL
    // returns what it was asked for; one that narrows in JavaScript shows up
    // here as a multiple of it.
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

function show(m: Measurement): string {
  return `${m.median.toFixed(2)}ms, ${m.work.requests} requests, ${m.work.rows} rows read`;
}

// ── The backends ─────────────────────────────────────────────────────────────

interface Backend {
  name: string;
  create(): { db: ArmadaDB & { close(): Promise<void> }; stop: () => void };
}

let dbSeq = 0;

const backends: Backend[] = [
  {
    name: "IndexedDBArmadaDB",
    create() {
      (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      const stop = instrumentIndexedDB();
      return { db: new IndexedDBArmadaDB(`armada-perf-${++dbSeq}`), stop };
    },
  },
  {
    name: "SqliteArmadaDB",
    create() {
      const db = new SqliteArmadaDB(new CountingSqlDriver(new NodeSqlDriver()));
      return { db, stop: () => {} };
    },
  },
];

describe.each(backends)("$name — NIP-17 read paths", ({ name, create }) => {
  let db: ArmadaDB & { close(): Promise<void> };
  let stop: () => void;
  let store: NRumorStore;

  beforeAll(async () => {
    ({ db, stop } = create());
    store = db.tenant(TENANT, tenantOptsFor(TENANT));
    resetWork();
    const t0 = performance.now();
    // In bursts, the way `writeDm17Rumors` writes a sync page — which is what
    // both engines are built for. Awaiting one rumor at a time instead makes
    // every write its own transaction and costs several times this, on both.
    for (let i = 0; i < RUMORS.length; i += BURST) {
      await Promise.all(RUMORS.slice(i, i + BURST).map((rumor) => store.event(rumor)));
    }
    const elapsed = performance.now() - t0;
    console.log(
      `[perf][${name}] ingest: ${RUMORS.length} rumors / ${CONVERSATIONS.length} conversations in ` +
        `bursts of ${BURST}: ${elapsed.toFixed(0)}ms (${((elapsed / RUMORS.length) * 1000).toFixed(0)}µs each), ` +
        `${work.requests} requests (${(work.requests / RUMORS.length).toFixed(1)} per rumor)`,
    );
  }, 900_000);

  afterAll(async () => {
    stop();
    await db.close();
  });

  it("reads a thread page without reading the thread", { timeout: 300_000 }, async () => {
    const page = (conv: Conversation) => async () => {
      const rows = await store.query([
        { kinds: DM_RUMOR_KINDS, search: dmConvTerm(conv.peers), limit: PAGE },
      ]);
      expect(rows.length).toBe(PAGE);
    };

    const busiest = await measure(2, page(BUSIEST));
    const middling = await measure(2, page(MIDDLING));

    console.log(
      `[perf][${name}] thread page (limit ${PAGE}): ` +
        `busiest thread (${BUSIEST.messages} msgs) ${show(busiest)} | ` +
        `middling thread (${MIDDLING.messages} msgs) ${show(middling)}`,
    );

    // Both pages are the same size, so both must cost the same work. A read
    // whose cost tracks the conversation's LENGTH is a scan wearing an index's
    // name — which is what it is when the whole thread is deserialized and
    // sliced to a page in JavaScript.
    expect(busiest.work.rows).toBeLessThan(PAGE * 4);
    expect(busiest.work.rows).toBeLessThan(middling.work.rows * 3 + PAGE);
  });

  it("pages older history for the cost of the page", { timeout: 300_000 }, async () => {
    const first = await store.query([
      { kinds: DM_RUMOR_KINDS, search: dmConvTerm(BUSIEST.peers), limit: PAGE },
    ]);
    const oldest = first[first.length - 1].created_at;

    const shallow = await measure(2, async () => {
      await store.query([{ kinds: DM_RUMOR_KINDS, search: dmConvTerm(BUSIEST.peers), limit: PAGE }]);
    });
    const deep = await measure(2, async () => {
      const rows = await store.query([
        { kinds: DM_RUMOR_KINDS, search: dmConvTerm(BUSIEST.peers), until: oldest - 1, limit: PAGE },
      ]);
      expect(rows.length).toBe(PAGE);
    });

    console.log(
      `[perf][${name}] thread paging: first page ${show(shallow)} | second page ${show(deep)}`,
    );

    // `until` is a bound on the index walk, not a filter over what came back:
    // the second page must not re-read the first.
    expect(deep.work.rows).toBeLessThan(shallow.work.rows * 2 + PAGE);
  });

  it("finds a conversation's timer without walking its history", { timeout: 300_000 }, async () => {
    const timer = (conv: Conversation) => async () => {
      const rows = await store.query([
        { kinds: [KIND_TIMER], search: dmConvTerm(conv.peers), limit: 1 },
      ]);
      expect(rows.length).toBe(1);
    };

    const busiest = await measure(2, timer(BUSIEST));
    const quietest = await measure(2, timer(QUIETEST));

    console.log(
      `[perf][${name}] timer read (limit 1, kinds+term): ` +
        `busiest thread (${BUSIEST.messages} msgs) ${show(busiest)} | ` +
        `quietest (${QUIETEST.messages} msgs) ${show(quietest)}`,
    );

    // One row is wanted and one row exists, at the very bottom of the thread.
    // The kind belongs in the index walk; applied to rows afterwards it costs
    // the whole conversation, which is ~300x the answer in the busiest thread.
    expect(busiest.work.rows).toBeLessThan(BUSIEST.messages / 4);
  });

  it("collapses the conversation list per conversation, not per message", { timeout: 300_000 }, async () => {
    const list = await measure(1, async () => {
      const rows = await store.query([
        { search: `distinct:${DM_MSG_TERM}` },
        { search: `distinct:${DM_MINE_TERM}` },
      ]);
      // One row per conversation per namespace, merged by id — the viewer has
      // written in every conversation here, and the two collapses agree
      // wherever the newest message is the viewer's.
      expect(rows.length).toBeGreaterThanOrEqual(CONVERSATIONS.length);
      expect(rows.length).toBeLessThanOrEqual(CONVERSATIONS.length * 2);
    });

    console.log(
      `[perf][${name}] conversation list, 2 collapses over ${CONVERSATIONS.length} conversations ` +
        `(${RUMORS.length} rumors): ${show(list)}`,
    );

    // The collapse walks the term index, not the rumors: the answer is two rows
    // per conversation, and the work must be within a small factor of it rather
    // than of the corpus. The sample-and-group read this replaced was the
    // corpus.
    expect(list.work.rows).toBeLessThan(CONVERSATIONS.length * 8);
  });

  it("keeps a whole-tenant scan available for the paths that need one", { timeout: 300_000 }, async () => {
    // The expiry sweep and local message search read pages of the tenant with
    // no term at all. They are meant to cost what they read — this is the
    // control that says the numbers above are small because of the index and
    // not because the corpus is.
    const sweep = await measure(1, async () => {
      const rows = await store.query([{ kinds: DM_RUMOR_KINDS, limit: 300 }]);
      expect(rows.length).toBe(300);
    });
    console.log(`[perf][${name}] untermed page (limit 300): ${show(sweep)}`);
    expect(sweep.work.rows).toBeGreaterThanOrEqual(300);
  });
});
