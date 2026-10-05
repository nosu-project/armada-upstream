/**
 * Relay mirror — seed newly-adopted relays with the community's history
 * (CORD-02 §6), BEFORE the relay-list edition publishes, so a joiner never folds
 * a half-arrived Control Plane. Signed wraps are copied verbatim.
 *
 * Mirrors the CORRECTNESS set only: Control and Guestbook for every held epoch,
 * rekey addresses between held epochs plus the pending next (CORD-06 §2), and
 * the dissolution address. Chat history stays where it was sent.
 */

import { controlGroups } from "@/concord/lib/control";
import { guestbookGroups } from "@/concord/lib/guestbook";
import {
  baseRekeyGroupKey,
  channelRekeyGroupKey,
  dissolvedGroupKey,
  type StreamKeyView,
} from "@/concord/lib/derive";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { registerStreamKeys } from "@/concord/lib/streamAuth";
import type { Community } from "@/concord/lib/types";
import { logSync } from "@/lib/syncLog";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable client the mirror needs (test seam). */
export interface MirrorNostr {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  };
}

export interface MirrorProgress {
  phase: "fetch" | "publish";
  relay: string;
  /** Events gathered (fetch) or delivered+failed (publish) so far. */
  done: number;
  /** Total wraps to deliver — 0 while still fetching. */
  total: number;
}

export interface MirrorRelayResult {
  accepted: number;
  /** Events the relay refused (policy — e.g. rejecting old `created_at`s) or failed. */
  rejected: number;
}

export interface MirrorReport {
  /** Distinct wraps found across the source relays. */
  found: number;
  perRelay: Map<string, MirrorRelayResult>;
}

const PAGE_LIMIT = 500;
/** Runaway guard: 40 pages × 500 = 20k wraps per author chunk, far past any real plane. */
const MAX_PAGES = 40;
const AUTHORS_PER_FILTER = 200;
/** Defensive ceiling on derivable addresses (heldRoots × channels × epochs). */
const MAX_GROUPS = 600;
const PUBLISH_CONCURRENCY = 10;

/** Every stream address whose history a new relay needs, derived from held keys alone. */
export function mirrorGroups(community: Community): StreamKeyView[] {
  const groups: StreamKeyView[] = [
    ...controlGroups(community),
    ...guestbookGroups(community),
    dissolvedGroupKey(community.id),
  ];
  // Base rotations: each held epoch's NEXT-epoch address.
  for (const r of community.heldRoots) {
    groups.push(baseRekeyGroupKey(r.key, community.id, r.epoch + 1n));
  }
  // Private channels: every epoch up to the pending next, under every held root —
  // a Refounding seals channel rekeys under the PRIOR root (CORD-06 §3).
  for (const ch of community.privateChannels) {
    const top = ch.epoch + 1n;
    for (let e = 1n; e <= top; e++) {
      for (const r of community.heldRoots) {
        groups.push(channelRekeyGroupKey(r.key, ch.id, e));
        if (groups.length >= MAX_GROUPS) break;
      }
      if (groups.length >= MAX_GROUPS) break;
    }
    if (groups.length >= MAX_GROUPS) {
      logSync("mirror", `${community.idHex.slice(0, 8)} group enumeration capped at ${MAX_GROUPS}`);
      break;
    }
  }
  const seen = new Set<string>();
  return groups.filter((g) => (seen.has(g.pk) ? false : (seen.add(g.pk), true)));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Mirror cancelled.", "AbortError");
}

/**
 * Walk one source relay's history for `authors` via `until` pages; a page adding
 * nothing new ends the walk (a same-second wall is accepted as done).
 */
async function fetchAllWraps(
  nostr: MirrorNostr,
  url: string,
  authors: string[],
  out: Map<string, NostrEvent>,
  onPage?: (gathered: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const authorChunk of chunk(authors, AUTHORS_PER_FILTER)) {
    let until: number | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      throwIfAborted(signal);
      const filter: NostrFilter = {
        kinds: [KIND_WRAP],
        authors: authorChunk,
        limit: PAGE_LIMIT,
        ...(until !== undefined ? { until } : {}),
      };
      const events = await nostr
        .relay(url)
        .query([filter], { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]) });
      let added = 0;
      let oldest = Infinity;
      for (const ev of events) {
        oldest = Math.min(oldest, ev.created_at);
        if (!out.has(ev.id)) {
          out.set(ev.id, ev);
          added++;
        }
      }
      onPage?.(out.size);
      if (events.length < PAGE_LIMIT || added === 0) break;
      until = oldest;
    }
  }
}

/**
 * Pacing for a relay that answers `rate-limited:`: wait, doubling to the cap,
 * and send one at a time until it accepts again. A relay that refuses this way
 * for `giveUpMs` straight has the rest counted as rejected.
 */
const rateLimitBackoff = { initialMs: 2_000, maxMs: 30_000, giveUpMs: 180_000 };

/** Test-only: shrink the rate-limit pacing. */
export function _configureMirrorBackoffForTests(cfg: Partial<typeof rateLimitBackoff>): void {
  Object.assign(rateLimitBackoff, cfg);
}

function isRateLimited(reason: unknown): boolean {
  return reason instanceof Error && /^rate-limited:/i.test(reason.message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Mirror cancelled.", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Mirror cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Deliver wraps to one target relay; every event is attempted, failures counted.
 * A refusal or loss gets one more try, after the rest (a transient socket loss
 * shouldn't count as a rejection). `rate-limited:` is not a refusal: those
 * events wait and go again, paced by {@link rateLimitBackoff}.
 */
async function publishWraps(
  nostr: MirrorNostr,
  url: string,
  wraps: NostrEvent[],
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
): Promise<MirrorRelayResult> {
  let accepted = 0;
  let rejected = 0;
  const queue = [...wraps];
  const retried = new Set<string>();
  let concurrency = PUBLISH_CONCURRENCY;
  let backoff = rateLimitBackoff.initialMs;
  let limitedSince: number | undefined;

  while (queue.length > 0) {
    throwIfAborted(signal);
    const batch = queue.splice(0, concurrency);
    const results = await Promise.allSettled(
      batch.map((w) => nostr.relay(url).event(w, { signal: AbortSignal.timeout(8000) })),
    );
    const limited: NostrEvent[] = [];
    let progressed = false;
    results.forEach((r, i) => {
      const wrap = batch[i];
      if (r.status === "fulfilled") {
        accepted++;
        progressed = true;
      } else if (isRateLimited(r.reason)) {
        limited.push(wrap);
      } else if (!retried.has(wrap.id)) {
        retried.add(wrap.id);
        queue.push(wrap);
      } else {
        rejected++;
      }
    });
    if (progressed) {
      backoff = rateLimitBackoff.initialMs;
      concurrency = Math.min(concurrency * 2, PUBLISH_CONCURRENCY);
      limitedSince = undefined;
    }
    onProgress?.(accepted + rejected);
    if (limited.length === 0) continue;

    limitedSince ??= Date.now();
    if (Date.now() - limitedSince >= rateLimitBackoff.giveUpMs) {
      logSync("mirror", `${url}: still rate-limited after ${Math.round((Date.now() - limitedSince) / 1000)}s — giving up`);
      rejected += limited.length + queue.length;
      queue.length = 0;
      onProgress?.(accepted + rejected);
      break;
    }
    queue.unshift(...limited);
    concurrency = 1;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, rateLimitBackoff.maxMs);
  }
  return { accepted, rejected };
}

/**
 * Copy the correctness-set history onto `targetRelays`. Idempotent: relays dedup by id.
 */
export async function mirrorHistoryToRelays(
  nostr: MirrorNostr,
  community: Community,
  targetRelays: string[],
  opts?: { onProgress?: (p: MirrorProgress) => void; signal?: AbortSignal },
): Promise<MirrorReport> {
  const groups = mirrorGroups(community);
  // New relays may NIP-42 auth-gate; scope our stream keys to them.
  registerStreamKeys(groups, targetRelays);

  const sources = community.relays.filter((url) => !targetRelays.includes(url));
  const authors = groups.map((g) => g.pk);
  const wraps = new Map<string, NostrEvent>();
  for (const url of sources) {
    try {
      await fetchAllWraps(
        nostr,
        url,
        authors,
        wraps,
        (gathered) => opts?.onProgress?.({ phase: "fetch", relay: url, done: gathered, total: 0 }),
        opts?.signal,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // A dead source only narrows the copy.
      logSync("mirror", `${url} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const all = [...wraps.values()].sort((a, b) => a.created_at - b.created_at);
  logSync(
    "mirror",
    `${community.idHex.slice(0, 8)}: ${all.length} wrap(s) from ${sources.length} source(s) → ${targetRelays.length} target(s) (${authors.length} address(es))`,
  );

  const perRelay = new Map<string, MirrorRelayResult>();
  for (const url of targetRelays) {
    const result = await publishWraps(
      nostr,
      url,
      all,
      (done) => opts?.onProgress?.({ phase: "publish", relay: url, done, total: all.length }),
      opts?.signal,
    );
    perRelay.set(url, result);
    logSync("mirror", `${url}: ${result.accepted}/${all.length} accepted, ${result.rejected} rejected`);
  }

  return { found: all.length, perRelay };
}
