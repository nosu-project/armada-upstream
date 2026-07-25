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
 *
 * Two completeness modes, chosen per plane:
 *
 * - COMPLETE (Control): correctness-critical and compaction-bounded, so every
 *   sweep re-fetches the WHOLE plane — no `since`, paging past the relay's
 *   per-filter limit. A forward cursor here silently starves the fold: the
 *   cursor key outlives a leave/ban/rejoin and the held-epoch set it was
 *   minted under, so any edition below the high-water mark that was never
 *   ingested (an unban published while the client was out, a compaction
 *   re-wrap under a newly-held epoch) stays invisible forever — the client
 *   then folds a STALE banlist/roster and mis-renders membership. Repeat
 *   sweeps stay cheap: a persisted seen-wrap memo skips the re-decrypt (the
 *   folds re-read the opened-event store), and `onFresh` fires only for wraps
 *   not yet processed.
 * - FORWARD (Guestbook): append-mostly and unbounded, so it keeps the
 *   persisted `since` cursor — but the cursor scope is keyed by the newest
 *   held epoch, so an epoch advance (rejoin, rekey adoption) re-baselines
 *   with one full backfill instead of trusting a cursor minted under a
 *   different read scope.
 */

import { currentControlGroup } from "@/concord-v2/lib/control";
import { guestbookGroups } from "@/concord-v2/lib/guestbook";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { readStreamCursor, updateStreamCursor, writeOpened } from "@/concord-v2/lib/rumorStore";
import { isStreamPubkey, streamAuthsSettled } from "@/concord-v2/lib/streamAuth";
import { openWrap, type OpenedEvent } from "@/concord-v2/lib/stream";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
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
  /** The scope key: single-flight identity, and (forward mode) the persisted cursor key. */
  scope: string;
  /** The stream keys whose addresses this plane's wraps are authored by. */
  groups: GroupKey[];
  /**
   * COMPLETE mode (see the module docstring): every sweep re-fetches the whole
   * plane instead of trusting a forward cursor. Reserved for planes that are
   * both correctness-critical and compaction-bounded (Control).
   */
  complete?: boolean;
  /** Called with this scope's decrypted events once they're committed. */
  onFresh?: (fresh: OpenedEvent[]) => void;
  /**
   * COMPLETE mode only: fired when the pager hit its budget and left older
   * events unfetched this round. A Refounding must abort on this — compacting
   * a truncated plane drops the unfetched entities from the new epoch.
   */
  onTruncated?: () => void;
  /**
   * COMPLETE mode only: page until the relay is exhausted, ignoring the hop
   * budget. Plane depth is attacker-controlled — any member can mint wraps —
   * so the budget exists to stop a routine sweep spending a launch on a flood.
   * A Refounding has no such option: it may only compact a plane it has read
   * WHOLE, so it opts in and pays whatever the depth costs.
   */
  exhaustive?: boolean;
}

/**
 * One community's Control Plane on one relay. COMPLETE: the fold that hangs
 * off this plane (roster, banlist, channels, registries) must never run on a
 * silently-truncated edition set — see the module docstring.
 *
 * CURRENT EPOCH ONLY. Concord's control plane is compaction-bounded: a
 * Refounding re-wraps every entity's head into the new epoch, so the current
 * plane is a complete snapshot and prior ones are dead weight — history, not
 * authority. Sweeping them too would mean a plane any member can inflate
 * follows the community across every future rotation, which is exactly what
 * rotating was supposed to escape. Old roots stay held (and stream-auth
 * registered) for chat history; only this fetch narrows.
 */
export function controlScope(
  community: CommunityV2,
  relayUrl: string,
  onFresh?: (fresh: OpenedEvent[]) => void,
): PlaneScope {
  return {
    scope: `control:${community.idHex}|${relayUrl}`,
    groups: [currentControlGroup(community)],
    complete: true,
    onFresh,
  };
}

/**
 * One community's Guestbook Plane on one relay. FORWARD-cursored, but the
 * cursor scope is keyed by the newest held epoch: a rejoin or rekey adoption
 * changes what the member can read, so the first sweep at the new epoch is a
 * full backfill — a cursor minted under the old read scope must never gate it.
 */
export function guestbookScope(
  community: CommunityV2,
  relayUrl: string,
  onFresh?: (fresh: OpenedEvent[]) => void,
): PlaneScope {
  return {
    scope: `guestbook:${community.idHex}@${community.rootEpoch}|${relayUrl}`,
    groups: guestbookGroups(community),
    onFresh,
  };
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

/** Max unbroken main-thread time (ms) spent decrypting before yielding
 *  (mirrors chat.ts's DECODE_SLICE_MS — see the rationale there). */
const PLANE_DECODE_SLICE_MS = 5;

/**
 * Time-sliced {@link openPlaneWraps}: the same decrypt, but yields the event
 * loop whenever a slice has run past {@link PLANE_DECODE_SLICE_MS}. Each wrap
 * costs a NIP-44 open + Schnorr verify (+ a second NIP-44 open for encrypted
 * seals) — all synchronous noble crypto — so decoding a whole plane in one
 * unbroken loop freezes the UI for the duration on a phone.
 */
export async function openPlaneWrapsChunked(wraps: NostrEvent[], groups: GroupKey[]): Promise<OpenedEvent[]> {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: OpenedEvent[] = [];
  let sliceStart = performance.now();
  for (let i = 0; i < wraps.length; i++) {
    const group = byPk.get(wraps[i].pubkey);
    if (group) {
      try {
        out.push(openWrap(wraps[i], group));
      } catch {
        // not ours / malformed
      }
    }
    if (i + 1 < wraps.length && performance.now() - sliceStart >= PLANE_DECODE_SLICE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  return out;
}

/** Paging knobs (test seam via {@link _configureSweepPagingForTests}). */
const paging = {
  /** Per-filter page size, shared by the batch REQ and the complete-mode pager. */
  pageLimit: 500,
  /** Complete-mode paging cap — far beyond any real (compacted) control plane. */
  maxPages: 8,
};

/** Test seam: shrink the page size so the pager is exercisable with few events. */
export function _configureSweepPagingForTests(cfg: Partial<typeof paging>): void {
  Object.assign(paging, cfg);
}

/**
 * Wrap ids a COMPLETE scope has already processed (decrypted or judged
 * garbage). Full-plane sweeps re-receive the same wraps every round — the
 * memo keeps repeat sweeps decrypt-free and `onFresh` quiet. Ids are global
 * (a wrap id is content-addressed), so the same wrap arriving from a second
 * relay is also deduped. Insertion-ordered, half-evicted at the cap.
 *
 * PERSISTED (foldedCache): an id is only noted after its decrypted rumor is
 * durably in the opened-event store (or it failed to decrypt under a held key
 * — permanent garbage, since every wrap here matched a held group's address),
 * and the folds re-read the store, so a cold launch can skip re-decrypting
 * the whole plane. A session-only memo made every relaunch re-pay the full
 * NIP-44+Schnorr pass over thousands of control wraps — the main-thread stall
 * on startup. Wiped with the rest of `armada-concord-cache` on logout; an
 * evicted or lost id merely re-decrypts once.
 */
const seenCompleteWraps = new Set<string>();
const SEEN_WRAPS_CAP = 16_384;
const SEEN_WRAPS_KEY = "plane-seen-wraps";
/** Debounce for the persisted-memo write, so a sweep burst is one write. */
const SEEN_WRAPS_PERSIST_MS = 1_000;

let seenWrapsLoaded: Promise<void> | undefined;
let seenWrapsPersistTimer: ReturnType<typeof setTimeout> | undefined;

/** Union the persisted memo into the session set (once per session). */
function loadSeenWraps(): Promise<void> {
  seenWrapsLoaded ??= readFolded<string[]>(SEEN_WRAPS_KEY)
    .then((ids) => {
      if (ids) for (const id of ids) seenCompleteWraps.add(id);
    })
    .catch(() => undefined);
  return seenWrapsLoaded;
}

function schedulePersistSeenWraps(): void {
  if (seenWrapsPersistTimer !== undefined) return;
  seenWrapsPersistTimer = setTimeout(() => {
    seenWrapsPersistTimer = undefined;
    void writeFolded(SEEN_WRAPS_KEY, [...seenCompleteWraps]);
  }, SEEN_WRAPS_PERSIST_MS);
}

/**
 * Mark wrap ids as processed. Call only once their rumors are durably in the
 * opened-event store (or they failed under a held key). Shared with the
 * wire's control-wrap ingest path, so a wrap decrypted by either transport is
 * never re-decrypted by the other.
 */
export function notePlaneWrapsSeen(ids: string[]): void {
  const before = seenCompleteWraps.size;
  for (const id of ids) seenCompleteWraps.add(id);
  if (seenCompleteWraps.size > SEEN_WRAPS_CAP) {
    let toDrop = seenCompleteWraps.size - SEEN_WRAPS_CAP / 2;
    for (const id of seenCompleteWraps) {
      if (toDrop-- <= 0) break;
      seenCompleteWraps.delete(id);
    }
  }
  if (seenCompleteWraps.size !== before) schedulePersistSeenWraps();
}

/** The subset of `wraps` not yet processed (loads the persisted memo first). */
export async function unseenPlaneWraps(wraps: NostrEvent[]): Promise<NostrEvent[]> {
  await loadSeenWraps();
  return wraps.filter((w) => !seenCompleteWraps.has(w.id));
}

/** Test seam: forget which wraps have been processed (session + persisted). */
export function _resetPlaneSweepMemoForTests(): void {
  seenCompleteWraps.clear();
  if (seenWrapsPersistTimer !== undefined) {
    clearTimeout(seenWrapsPersistTimer);
    seenWrapsPersistTimer = undefined;
  }
  seenWrapsLoaded = Promise.resolve();
  void writeFolded(SEEN_WRAPS_KEY, []);
}

/**
 * Scope keys whose most recent COMPLETE sweep left events behind (pager cap).
 * Kept module-level so a caller that JOINED an in-flight sweep can still read
 * the verdict after awaiting it — the joiner's own callbacks never fire.
 */
const truncatedScopes = new Set<string>();

/** Whether any relay's last control sweep for this community was truncated. */
export function controlSweepTruncated(community: CommunityV2): boolean {
  return community.relays.some((url) => truncatedScopes.has(`control:${community.idHex}|${url}`));
}

/**
 * Page a COMPLETE scope past the relay's per-filter limit: `until` the oldest
 * wrap seen so far, until a short page says the relay is exhausted. `until` is
 * inclusive, so pages overlap by design (dedupe by id) — the overlap is what
 * steps over a same-second boundary instead of skipping it.
 *
 * Pages STREAM to `onPage` and are then dropped; only wrap ids are retained,
 * for the cross-page dedupe. Plane depth is attacker-controlled (any member
 * holds the key that mints wraps), so a deep plane must cost bandwidth and
 * time, never heap — accumulating it here is how a flood becomes an OOM
 * instead of a slow sync. Returns the distinct wrap count.
 */
async function fetchCompleteScope(
  nostr: NostrLike,
  url: string,
  filter: NostrFilter,
  first: NostrEvent[],
  onPage: (page: NostrEvent[]) => Promise<void>,
  onTruncated?: () => void,
  exhaustive = false,
): Promise<number> {
  const seen = new Set(first.map((e) => e.id));
  let oldest = Math.min(...first.map((e) => e.created_at));
  await onPage(first);
  let lastPage = first.length;
  for (let hops = 0; lastPage >= paging.pageLimit; hops++) {
    if (!exhaustive && hops >= paging.maxPages) {
      // No silent caps: a plane this deep exceeds the pager's budget.
      logSync("sweep", `complete-scope pager hit ${paging.maxPages} pages on ${url} — older events left behind this round`);
      onTruncated?.();
      break;
    }
    const older = await nostr.relay(url).query([{ ...filter, until: oldest }], {
      signal: AbortSignal.timeout(15_000),
    });
    const fresh = older.filter((e) => !seen.has(e.id));
    if (fresh.length === 0) {
      // Nothing new behind the boundary. A SHORT page means the relay is
      // simply exhausted; a FULL one means a same-second wall thicker than the
      // limit, which no `until` can step past — so everything older than it
      // stays unreachable and this sweep is truncated like any other.
      if (older.length >= paging.pageLimit) {
        logSync("sweep", `complete-scope hit a same-second wall on ${url} — older events unreachable this round`);
        onTruncated?.();
      }
      break;
    }
    for (const e of fresh) seen.add(e.id);
    oldest = Math.min(oldest, ...fresh.map((e) => e.created_at));
    await onPage(fresh);
    lastPage = older.length;
  }
  return seen.size;
}

/**
 * Run one relay's batch: one filter per scope (cursor-gated for forward
 * scopes, whole-plane for complete ones), ONE query, demuxed by wrap author.
 * Retries once on failure (cursors stay put so the next sweep re-asks). Not
 * abortable by callers — the REQ is shared.
 */
async function runScopes(
  nostr: NostrLike,
  url: string,
  scopes: PlaneScope[],
): Promise<Map<string, OpenedEvent[]>> {
  // The persisted seen-wrap memo must be in the session set before the
  // complete-scope narrowing below, or a cold launch re-decrypts everything.
  await loadSeenWraps();
  const cursors = await Promise.all(
    scopes.map((s) => (s.complete ? undefined : readStreamCursor(s.scope))),
  );
  const filters: NostrFilter[] = scopes.map((s, i) => ({
    kinds: [KIND_WRAP],
    authors: s.groups.map((g) => g.pk),
    limit: paging.pageLimit,
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

      const freshPerScope: OpenedEvent[][] = scopes.map(() => []);
      const totals: number[] = scopes.map((_, i) => perScope[i].length);

      // A complete scope STREAMS: decrypt (time-sliced — a cold plane is
      // thousands of synchronous EC ops), store and memo each page, then drop
      // it. The folds read the opened-event store, not this sweep's result, so
      // no page needs to outlive its own iteration.
      for (const [i, s] of scopes.entries()) {
        if (!s.complete) continue;
        truncatedScopes.delete(s.scope);
        const ingest = async (page: NostrEvent[]) => {
          // Narrow by the memo BEFORE advancing it, or nothing ever decrypts.
          const opened = await openPlaneWrapsChunked(
            page.filter((w) => !seenCompleteWraps.has(w.id)),
            s.groups,
          );
          if (opened.length > 0) {
            await writeOpened(opened);
            for (const e of opened) freshPerScope[i].push(e);
          }
          // Only the memo advances, and only once the rumors are durably
          // stored — every sweep re-asks for the whole plane, so nothing
          // received can ever become unreachable.
          notePlaneWrapsSeen(page.map((w) => w.id));
        };
        totals[i] = await fetchCompleteScope(
          nostr,
          url,
          filters[i],
          perScope[i],
          ingest,
          () => {
            truncatedScopes.add(s.scope);
            s.onTruncated?.();
          },
          s.exhaustive,
        );
        perScope[i] = [];
      }

      // Forward scopes stay one batch — their `since` already narrowed them —
      // then ONE store write and parallel cursor advances.
      const forwardFresh: OpenedEvent[] = [];
      for (const [i, s] of scopes.entries()) {
        if (s.complete) continue;
        for (const e of await openPlaneWrapsChunked(perScope[i], s.groups)) {
          freshPerScope[i].push(e);
          forwardFresh.push(e);
        }
      }
      if (forwardFresh.length > 0) await writeOpened(forwardFresh);
      await Promise.all(
        scopes.map((s, i) => {
          logSync(
            "sweep",
            `${s.scope} → ${totals[i]} event(s), ${freshPerScope[i].length} new in ${sinceMs(started)} (${s.complete ? "full" : `since=${cursors[i]?.newest ?? "∅"}`}, authors×${s.groups.length})`,
          );
          if (s.complete) return undefined; // memoed per page above
          const mine = perScope[i];
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

/**
 * Sweep one community's Control Plane (editions across held epochs).
 * `exhaustive` pages to the end of the plane however deep it is — for the
 * Refounding path, which may only compact what it has read whole.
 */
export function sweepControl(
  nostr: NostrLike,
  community: CommunityV2,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void; exhaustive?: boolean },
): Promise<OpenedEvent[]> {
  const scopeOf: typeof controlScope = (c, url, onFresh) => ({
    ...controlScope(c, url, onFresh),
    exhaustive: opts?.exhaustive,
  });
  return sweepCommunityPlane(nostr, community, scopeOf, opts);
}

/** Sweep one community's Guestbook Plane (membership motions). */
export function sweepGuestbook(
  nostr: NostrLike,
  community: CommunityV2,
  opts?: { onFresh?: (fresh: OpenedEvent[]) => void },
): Promise<OpenedEvent[]> {
  return sweepCommunityPlane(nostr, community, guestbookScope, opts);
}
