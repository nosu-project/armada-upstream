/**
 * Read-back of this account's own Concord sends (`outgoing.ts`): an OK is only a
 * claim, so an accepted wrap is asked for by id, batched per relay. Found nowhere,
 * it is re-broadcast once and then marked failed. Relays that keep accepting what
 * they don't store stop counting as a delivery on their own word (`isRelayTrusted`).
 */
import {
  failOutgoing,
  forgetOutgoing,
  getOutgoing,
  outgoingAwaitingVerify,
  updateOutgoing,
  type OutgoingRecord,
} from "@/concord/lib/outgoing";
import { KvPrefixCache } from "@/lib/db/kvCache";
import { logSync } from "@/lib/syncLog";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

export interface VerifyPool {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** Wait this long after the first OK: relays index a beat after answering. */
let verifyDelayMs = 10_000;
const QUERY_TIMEOUT_MS = 8_000;
/** Re-broadcasts after a read-back that found nothing, before it is shown failed. */
const MAX_VERIFY_ATTEMPTS = 1;
/** A relay is distrusted after this many false OKs, if they outnumber its true ones. */
const DISTRUST_MISSES = 3;

interface RelayRecord {
  hits: number;
  misses: number;
}

const trust = new KvPrefixCache<RelayRecord>({ prefix: "c2relayack:" });

/** Whether `url`'s OK alone counts as delivered. Unknown relays are trusted. */
export function isRelayTrusted(url: string): boolean {
  if (!trust.warmed) void trust.ready();
  const r = trust.get(url);
  return !r || r.misses < DISTRUST_MISSES || r.misses <= r.hits;
}

function score(url: string, stored: boolean): void {
  const r = trust.get(url) ?? { hits: 0, misses: 0 };
  // Hits only matter against misses: an honest relay costs no write (a KV bridge call on Android).
  if (stored && r.misses === 0) return;
  trust.set(url, stored ? { ...r, hits: r.hits + 1 } : { ...r, misses: r.misses + 1 });
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let pool: VerifyPool | undefined;
let resend: ((rec: OutgoingRecord) => void) | undefined;

/** Mark a send accepted and queue its read-back. `rebroadcast` re-sends the wrap if it's found nowhere. */
export function verifyOutgoing(
  nostr: VerifyPool,
  rumorId: string,
  acked: string[],
  rebroadcast: (rec: OutgoingRecord) => void,
): void {
  const rec = getOutgoing(rumorId);
  if (!rec || !rec.wrap) return;
  updateOutgoing(rumorId, { verifyAt: rec.verifyAt ?? Date.now() + verifyDelayMs, acked: [...new Set([...(rec.acked ?? []), ...acked])] });
  scheduleVerify(nostr, rebroadcast);
}

/** Queue the next batched read-back (also on load, for records that outlived a page). */
export function scheduleVerify(nostr: VerifyPool, rebroadcast: (rec: OutgoingRecord) => void): void {
  pool = nostr;
  resend = rebroadcast;
  if (timer !== undefined || running) return;
  const next = Math.min(...outgoingAwaitingVerify().map((r) => r.verifyAt!));
  if (!Number.isFinite(next)) return;
  timer = setTimeout(() => void runVerify(), Math.max(0, next - Date.now()));
}

async function runVerify(): Promise<void> {
  timer = undefined;
  if (!pool) return;
  running = true;
  try {
    const now = Date.now();
    const due = outgoingAwaitingVerify().filter((r) => r.verifyAt! <= now);
    if (due.length === 0) return;
    // One query per relay for everything due there.
    const byRelay = new Map<string, OutgoingRecord[]>();
    for (const rec of due) {
      for (const url of rec.relays) {
        const list = byRelay.get(url) ?? [];
        list.push(rec);
        byRelay.set(url, list);
      }
    }
    const seen = new Map<string, Set<string> | undefined>();
    const p = pool;
    await Promise.all(
      [...byRelay].map(async ([url, recs]) => {
        const ids = recs.map((r) => r.wrap!.id);
        const authors = [...new Set(recs.map((r) => r.wrap!.pubkey))];
        try {
          const events = await p.relay(url).query([{ kinds: [1059], authors, ids }], {
            signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
          });
          seen.set(url, new Set(events.map((e) => e.id)));
        } catch {
          seen.set(url, undefined); // didn't answer: proves nothing either way
        }
      }),
    );
    for (const rec of due) {
      const id = rec.wrap!.id;
      const answered = rec.relays.filter((url) => seen.get(url) !== undefined);
      const holders = answered.filter((url) => seen.get(url)!.has(id));
      for (const url of rec.acked ?? []) {
        if (seen.get(url) !== undefined) score(url, seen.get(url)!.has(id));
      }
      if (holders.length > 0) {
        logSync("send", `wrap ${id.slice(0, 8)} read back from ${holders.length} relay(s)`);
        forgetOutgoing(rec.rumorId);
      } else if (answered.length === 0) {
        updateOutgoing(rec.rumorId, { verifyAt: Date.now() + verifyDelayMs }); // no relay reachable: ask again later
      } else if ((rec.verifyAttempts ?? 0) < MAX_VERIFY_ATTEMPTS) {
        logSync("send", `wrap ${id.slice(0, 8)} accepted but on no relay; re-broadcasting`);
        updateOutgoing(rec.rumorId, { verifyAt: undefined, acked: [], verifyAttempts: (rec.verifyAttempts ?? 0) + 1, state: "sending" });
        resend?.(getOutgoing(rec.rumorId)!);
      } else {
        logSync("send", `wrap ${id.slice(0, 8)} accepted but on no relay after re-broadcast; failed`);
        updateOutgoing(rec.rumorId, { verifyAt: undefined, acked: [] });
        failOutgoing(rec.rumorId);
      }
    }
  } finally {
    running = false;
    if (pool && resend) scheduleVerify(pool, resend);
  }
}

export const _scoreForTests = score;

export function outgoingVerifyReady(): Promise<void> {
  return trust.ready();
}

export function _setVerifyDelayForTests(ms: number): void {
  verifyDelayMs = ms;
}

/** Logout: drop the queue (the KV map is reset by `resetKvCaches`). */
export function clearOutgoingVerifyMemory(): void {
  clearTimeout(timer);
  timer = undefined;
  pool = undefined;
  resend = undefined;
}
