/**
 * Plane sweeps — the ONE fetch/decrypt/cursor discipline for a community's
 * kind-1059 planes (control, guestbook), shared by the per-community hooks
 * and the global background sweep.
 *
 * - AUTH-GATED: holds every REQ until the scopes' stream keys are
 *   NIP-42-registered and (on a challenged socket) their AUTHs are ACKED by
 *   the relay, with a hard cap so a key that never registers can't stall
 *   sync. The ack is the relay's own `OK` — no settle-timer guesswork.
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
import { isStreamPubkey, streamAuthsSettled } from "@/concord-v2/lib/streamAuth";
import { openWrap, type OpenedEvent } from "@/concord-v2/lib/stream";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { beginSyncTask } from "@/lib/syncActivity";
import { logSync, sinceMs } from "@/lib/syncLog";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Minimal relay-capable Nostr client the sweeps need (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** Auth gate timing (test seam via {@link _configureAuthWaitForTests}). */
const authWait = {
  /** Hard cap so a key that never registers/acks can't stall sync. */
  maxWaitMs: 8_000,
};

/** Test seam: shrink (or zero) the auth gate so sweeps run immediately. */
export function _configureAuthWaitForTests(cfg: Partial<typeof authWait>): void {
  Object.assign(authWait, cfg);
}

/**
 * Resolve once every group is registered AND its AUTH is acked on `url` (or
 * the relay never challenged — then there's nothing to wait for), or the cap
 * expires. Ack state comes from the relay's own `OK` replies (streamAuth).
 */
async function whenAuthReady(url: string, groupsOf: () => GroupKey[]): Promise<void> {
  const deadline = Date.now() + authWait.maxWaitMs;
  for (;;) {
    const pks = groupsOf().map((g) => g.pk);
    const registered = pks.every((pk) => isStreamPubkey(pk));
    if ((registered && streamAuthsSettled(url, pks)) || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, deadline - Date.now()))));
  }
}

/**
 * Wait until `url` has ACKED the AUTHs for every group — but only if the relay
 * actually challenged this socket (an unchallenged relay isn't auth-gating, or
 * its lazy challenge will be triggered by the REQ itself and covered by the
 * pool's auth-retry). Same cap/test seam as the sweep gate.
 *
 * This is the gate for NON-sweep reads (channel backfills, the login warm-up's
 * newest-page pulls): a kind-1059 REQ racing NIP-42 gets CLOSED by the relay
 * and reads back as a clean empty page — which is how a fresh login used to
 * "complete" with zero messages and drop the user into hollow rooms.
 */
export async function whenAuthSettled(url: string, groupsOf: () => GroupKey[]): Promise<void> {
  const deadline = Date.now() + authWait.maxWaitMs;
  for (;;) {
    if (streamAuthsSettled(url, groupsOf().map((g) => g.pk)) || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(50, deadline - Date.now()))));
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
      // Pause, then re-check the auth gate before the retry: a first round
      // lost to a lazy NIP-42 challenge (REQ → CLOSED auth-required → AUTHs
      // sent) passes once the relay has acked the stream AUTHs.
      await new Promise((r) => setTimeout(r, 250));
      await whenAuthReady(url, () => scopes.flatMap((s) => s.groups));
    }
  }
  return out;
}

/** In-flight sweeps by cursor scope (see the single-flight docstring). */
const inflight = new Map<string, Promise<OpenedEvent[]>>();

/** Extra enrollment time for an OPEN gate, so same-render callers coalesce. */
const BATCH_WINDOW_MS = 50;

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
    // The whole batch lifetime — enrollment window, NIP-42 auth gate, the REQ
    // itself — counts as sync activity (the auth hold alone can be seconds).
    const task = beginSyncTask("community updates");
    try {
      await new Promise((r) => setTimeout(r, BATCH_WINDOW_MS));
      await whenAuthReady(url, () => b.scopes.flatMap((s) => s.groups));
      b.closed = true;
      if (batches.get(url) === b) batches.delete(url);
      return await runScopes(nostr, url, b.scopes);
    } finally {
      task.end();
    }
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
