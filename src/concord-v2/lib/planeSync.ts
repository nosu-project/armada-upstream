/**
 * Plane sweeps — the ONE fetch/decrypt/cursor discipline for a community's
 * kind-1059 planes (control, guestbook), shared by the per-community hooks
 * and the global background sweep.
 *
 * - AUTH-GATED: holds every REQ until the scopes' stream keys are
 *   NIP-42-registered and the post-registration socket swap has settled,
 *   with a hard cap so a key that never registers can't stall sync.
 * - BATCHED: same-relay scopes coalesce into one REQ (one filter per scope,
 *   each with its own cursor and limit — per-filter isolation prevents the
 *   issue-#19 since-skip).
 * - SINGLE-FLIGHT: overlapping sweeps of the same scope join the in-flight
 *   fetch instead of re-paying the full history.
 */

import { controlGroups } from "@/concord-v2/lib/control";
import { guestbookGroups } from "@/concord-v2/lib/guestbook";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { readStreamCursor, updateStreamCursor, writeOpened } from "@/concord-v2/lib/rumorStore";
import { isStreamPubkey, onStreamKeysAdded } from "@/concord-v2/lib/streamAuth";
import { openWrap, type OpenedEvent } from "@/concord-v2/lib/stream";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { normalizeRelayUrl } from "@/lib/platform";
import { logSync, sinceMs } from "@/lib/syncLog";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable Nostr client the sweeps need (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/**
 * Delay after stream-key registration before a plane REQ may fly, so the
 * NIP-42 socket swap settles first.
 */
export const STREAM_AUTH_SETTLE_MS = 2_000;

/** Auth gate timings (test seam via {@link _configureAuthWaitForTests}). */
const authWait = {
  settleMs: STREAM_AUTH_SETTLE_MS,
  /** Hard cap so a key that never registers can't stall sync. */
  maxWaitMs: 8_000,
};

/** Test seam: shrink (or zero) the auth gate so sweeps run immediately. */
export function _configureAuthWaitForTests(cfg: Partial<typeof authWait>): void {
  Object.assign(authWait, cfg);
}

/** When each stream pubkey was registered (this page-life). Settled from the batch's own keys only. */
const registeredAt = new Map<string, number>();
onStreamKeysAdded((added) => {
  const now = Date.now();
  for (const pk of added) registeredAt.set(pk, now);
});

/** Resolve once every group is registered AND settled, or the cap expires. */
async function whenAuthReady(groupsOf: () => GroupKey[]): Promise<void> {
  const deadline = Date.now() + authWait.maxWaitMs;
  for (;;) {
    const now = Date.now();
    const pks = groupsOf().map((g) => g.pk);
    const registered = pks.every((pk) => isStreamPubkey(pk));
    // Keys registered before this module loaded default to 0 — long settled.
    const newest = pks.reduce((max, pk) => Math.max(max, registeredAt.get(pk) ?? 0), 0);
    if ((registered && now >= newest + authWait.settleMs) || now >= deadline) return;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(100, deadline - now))));
  }
}

/** One community-plane on one relay: a filter + its persisted cursor. */
export interface PlaneScope {
  /** The persisted cursor scope key (shared by hooks and the global sweep). */
  scope: string;
  /** The stream keys whose addresses this plane's wraps are authored by. */
  groups: GroupKey[];
  /** Called with this scope's decrypted events once they're committed. */
  onFresh?: (fresh: OpenedEvent[]) => void;
}

/** One community's Control Plane on one relay. */
export function controlScope(
  community: CommunityV2,
  relayUrl: string,
  onFresh?: (fresh: OpenedEvent[]) => void,
): PlaneScope {
  return { scope: `control:${community.idHex}|${relayUrl}`, groups: controlGroups(community), onFresh };
}

/** One community's Guestbook Plane on one relay. */
export function guestbookScope(
  community: CommunityV2,
  relayUrl: string,
  onFresh?: (fresh: OpenedEvent[]) => void,
): PlaneScope {
  return { scope: `guestbook:${community.idHex}|${relayUrl}`, groups: guestbookGroups(community), onFresh };
}

/** Merge opened-event sets by rumor id (a partial round must not drop editions). */
export function mergeOpened(...sets: OpenedEvent[][]): OpenedEvent[] {
  const byId = new Map<string, OpenedEvent>();
  for (const set of sets) for (const e of set) byId.set(e.rumorId, e);
  return [...byId.values()];
}

/** Decrypt raw plane wraps under the held groups into opened events. */
export function openPlaneWraps(wraps: NostrEvent[], groups: GroupKey[]): OpenedEvent[] {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: OpenedEvent[] = [];
  for (const wrap of wraps) {
    const group = byPk.get(wrap.pubkey);
    if (!group) continue;
    try {
      out.push(openWrap(wrap, group));
    } catch {
      // not ours / malformed
    }
  }
  return out;
}

/**
 * Run one relay's batch: one cursor-gated filter per scope, ONE query,
 * demuxed by wrap author. Retries once on failure (cursors stay put so the
 * next sweep re-asks). Not abortable by callers — the REQ is shared.
 */
async function runScopes(
  nostr: NostrLike,
  url: string,
  scopes: PlaneScope[],
): Promise<Map<string, OpenedEvent[]>> {
  const cursors = await Promise.all(scopes.map((s) => readStreamCursor(s.scope)));
  const filters: NostrFilter[] = scopes.map((s, i) => ({
    kinds: [KIND_WRAP],
    authors: s.groups.map((g) => g.pk),
    limit: 500,
    ...(cursors[i]?.newest ? { since: cursors[i]!.newest } : {}),
  }));
  const out = new Map<string, OpenedEvent[]>(scopes.map((s) => [s.scope, []]));

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const events = await nostr.relay(url).query(filters, {
        signal: AbortSignal.timeout(15_000),
      });

      // Demux by wrap author: every scope's stream addresses are distinct.
      const scopeByPk = new Map<string, number>();
      scopes.forEach((s, i) => s.groups.forEach((g) => scopeByPk.set(g.pk, i)));
      const perScope: NostrEvent[][] = scopes.map(() => []);
      for (const ev of events) {
        const i = scopeByPk.get(ev.pubkey);
        if (i !== undefined) perScope[i].push(ev);
      }

      // Decrypt everything, then ONE store write and parallel cursor advances.
      const freshPerScope = scopes.map((s, i) => openPlaneWraps(perScope[i], s.groups));
      const allFresh = freshPerScope.flat();
      if (allFresh.length > 0) await writeOpened(allFresh);
      await Promise.all(
        scopes.map((s, i) => {
          const mine = perScope[i];
          logSync(
            "sweep",
            `${s.scope} → ${mine.length} event(s) in ${sinceMs(started)} (since=${cursors[i]?.newest ?? "∅"}, authors×${s.groups.length})`,
          );
          if (mine.length === 0) return undefined;
          return updateStreamCursor(s.scope, { newest: Math.max(...mine.map((e) => e.created_at)) });
        }),
      );
      for (const [i, s] of scopes.entries()) {
        const fresh = freshPerScope[i];
        if (fresh.length === 0) continue;
        out.set(s.scope, fresh);
        s.onFresh?.(fresh);
      }
      return out;
    } catch (err) {
      logSync(
        "sweep",
        `${url} sweep FAILED in ${sinceMs(started)} (${scopes.length} scope(s), attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt >= 2) break;
      // Pause before the retry: if lost to a socket swap, the fresh challenge
      // lands within the settle window.
      await new Promise((r) => setTimeout(r, authWait.settleMs));
    }
  }
  return out;
}

/** In-flight sweeps by cursor scope (see the single-flight docstring). */
const inflight = new Map<string, Promise<OpenedEvent[]>>();

/** Extra enrollment time for an OPEN gate, so same-render callers coalesce. */
const BATCH_WINDOW_MS = 50;

/** Relays with a sweep REQ in the air (normalized url → active batch count). */
const activeSweeps = new Map<string, number>();
/** Resolvers parked on a relay going sweep-idle. */
const idleWaiters = new Map<string, Array<() => void>>();

const relayKey = (url: string) => normalizeRelayUrl(url) ?? url;

/** Whether a sweep REQ is in flight on this relay. */
export function isRelaySweeping(url: string): boolean {
  return (activeSweeps.get(relayKey(url)) ?? 0) > 0;
}

/**
 * Resolve once no sweep is in flight on `url`. NostrProvider awaits this
 * before swapping a relay's socket: the swap only helps future REQs, and
 * tearing the socket under a live sweep strands its data.
 */
export function whenRelaySweepsIdle(url: string, capMs = 30_000): Promise<void> {
  const key = relayKey(url);
  if ((activeSweeps.get(key) ?? 0) === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, capMs);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    const waiters = idleWaiters.get(key) ?? [];
    waiters.push(done);
    idleWaiters.set(key, waiters);
  });
}

/** Track one batch's flight on a relay, waking idle-waiters on last-out. */
async function trackSweep<T>(url: string, run: () => Promise<T>): Promise<T> {
  const key = relayKey(url);
  activeSweeps.set(key, (activeSweeps.get(key) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (activeSweeps.get(key) ?? 1) - 1;
    if (left > 0) {
      activeSweeps.set(key, left);
    } else {
      activeSweeps.delete(key);
      const waiters = idleWaiters.get(key);
      idleWaiters.delete(key);
      if (waiters) for (const wake of waiters) wake();
    }
  }
}

/** A per-relay batch collecting scopes until the auth gate opens. */
interface RelayBatch {
  scopes: PlaneScope[];
  closed: boolean;
  promise: Promise<Map<string, OpenedEvent[]>>;
}
const batches = new Map<string, RelayBatch>();

/** Build and register a fresh batch; its promise resolves after the auth gate. */
function newBatch(nostr: NostrLike, url: string): RelayBatch {
  const b: RelayBatch = { scopes: [], closed: false, promise: Promise.resolve(new Map()) };
  b.promise = (async () => {
    await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS));
    await whenAuthReady(() => b.scopes.flatMap((s) => s.groups));
    b.closed = true;
    if (batches.get(url) === b) batches.delete(url);
    return trackSweep(url, () => runScopes(nostr, url, b.scopes));
  })();
  batches.set(url, b);
  return b;
}

/** Enroll one scope into the relay's open batch (creating one if needed). */
function enqueue(nostr: NostrLike, url: string, scope: PlaneScope): Promise<OpenedEvent[]> {
  const batch = batches.get(url);
  const b = batch && !batch.closed ? batch : newBatch(nostr, url);
  b.scopes.push(scope);
  const one = b.promise.then((m) => m.get(scope.scope) ?? []);
  inflight.set(scope.scope, one);
  void one.finally(() => {
    if (inflight.get(scope.scope) === one) inflight.delete(scope.scope);
  });
  return one;
}

/**
 * Sweep a set of scopes on ONE relay. Scopes already in flight (any caller)
 * are JOINED, not re-fetched — the joiner still gets the scope's fresh events
 * and its own `onFresh`. New scopes enroll in the relay's open batch behind
 * the auth gate and leave as one REQ (see module docstring).
 */
export async function sweepRelayScopes(
  nostr: NostrLike,
  url: string,
  scopes: PlaneScope[],
): Promise<Map<string, OpenedEvent[]>> {
  const results = scopes.map((s) => {
    const existing = inflight.get(s.scope);
    if (existing) {
      return existing.then((fresh) => {
        if (fresh.length > 0) s.onFresh?.(fresh);
        return [s.scope, fresh] as const;
      });
    }
    return enqueue(nostr, url, s).then((fresh) => [s.scope, fresh] as const);
  });
  return new Map(await Promise.all(results));
}

/** Sweep one community's plane across its relays; union deduped by rumor id. */
async function sweepCommunityPlane(
  nostr: NostrLike,
  community: CommunityV2,
  scopeOf: typeof controlScope,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void },
): Promise<OpenedEvent[]> {
  const results = await Promise.all(
    community.relays.map((url) => sweepRelayScopes(nostr, url, [scopeOf(community, url, opts?.onFresh)])),
  );
  return mergeOpened(...results.map((m) => [...m.values()].flat()));
}

/** Sweep one community's Control Plane (editions across held epochs). */
export function sweepControl(
  nostr: NostrLike,
  community: CommunityV2,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void },
): Promise<OpenedEvent[]> {
  return sweepCommunityPlane(nostr, community, controlScope, opts);
}

/** Sweep one community's Guestbook Plane (membership motions). */
export function sweepGuestbook(
  nostr: NostrLike,
  community: CommunityV2,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void },
): Promise<OpenedEvent[]> {
  return sweepCommunityPlane(nostr, community, guestbookScope, opts);
}
