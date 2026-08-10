/**
 * Author profile sync — the `profiles` sync topic.
 *
 * The read side is store-first: `useAuthor` reads ArmadaDB only, so a known
 * profile paints from disk with no network on the path. This module owns the
 * whole network side. Components declare which pubkeys are on screen
 * ({@link demandProfiles}); a single scheduler topic drains that demand in
 * batched relay rounds, writes the results into the `main` tenant, and seeds
 * the shared `['author', pubkey]` query cache (newest-wins) so mounted rows
 * update in place.
 *
 * One topic, not one per pubkey: the scheduler's lanes and stamps are built
 * for a handful of coarse topics, and a member list is hundreds of pubkeys
 * that want to travel in ONE batched REQ, not hundreds of single-flight runs.
 * Per-pubkey freshness lives here instead, as durable KV stamps
 * (`profile-fresh:<pubkey>`), so remounts and relaunches inside the window
 * cost no network at all — the refetch-interval polling this replaces reset
 * on every mount.
 *
 * Relay targeting is the second half of the fix. The pool routes generic
 * kinds to the user's general relays, but a community member's kind 0 often
 * lives only where the community lives. A mounted community/server view
 * registers its relays as HINTS ({@link addProfileRelayHints}); every run
 * asks the hinted relays about the still-stale pubkeys alongside the general
 * pool pass. Hint registration bumps a generation that lets missing profiles
 * be re-asked immediately when a new relay shows up, instead of waiting out
 * their miss stamp.
 */
import { KvPrefixCache } from "@/lib/db/kvCache";
import { appEventStore } from "@/lib/db/mainEventStore";
import { seedAuthorCache } from "@/lib/authorCache";
import { invalidateSyncTopic, registerSyncTopic, want } from "@/sync/syncManager";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { QueryClient } from "@tanstack/react-query";

/** Minimal Nostr client a run needs (batcher-backed). */
interface NostrLike {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/** What a run needs beyond the demand itself. Registered by the live hooks. */
export interface ProfileSyncContext {
  nostr: NostrLike;
  queryClient: QueryClient;
}

export const PROFILE_SYNC_TOPIC = "profiles";

/** A profile we HAVE is re-checked no sooner than this. */
const FOUND_STALE_MS = 15 * 60_000;
/** A profile we MISSED is re-asked no sooner than this (same hint set). */
const MISS_RETRY_MS = 60_000;
/** Hinted relays asked per run, at most. */
const MAX_HINT_RELAYS = 6;
/** Pubkeys per REQ against a hinted relay. */
const HINT_CHUNK = 50;
/**
 * How long a run waits before snapshotting demand. A mounting list registers
 * one demand per row across the same effect flush (and a virtualized list
 * across a couple of frames); the first `want` can start a run synchronously,
 * so an immediate snapshot would batch exactly one pubkey.
 */
const SETTLE_MS = 50;

/** On-screen pubkeys, refcounted by mounted demands. */
const demand = new Map<string, number>();

/**
 * The ONE scheduler want held while any demand is mounted. A member list is
 * hundreds of rows mounting and releasing per scroll frame; a want token (and
 * its scheduler pass) per row is where the CPU went — the `demand` map above
 * is the real refcount, so the scheduler only needs to know "someone cares".
 */
let topicWant: (() => void) | undefined;
let demandHolds = 0;

/**
 * Pubkeys a run FOUND (in the store or on the wire) this session. Picks the
 * lazy TTL in {@link isDueNow}; before a run has seen a pubkey the check
 * degrades toward "due", never toward wrongly skipping.
 */
const foundProfiles = new Set<string>();

/** Relays worth asking about profiles right now, refcounted by mounted views. */
const hintRelays = new Map<string, number>();

/**
 * Bumped when a never-before-hinted relay registers. A missing profile is
 * re-asked when the generation moved past its last attempt, so a community's
 * relays arriving AFTER the first (general-pool) round re-run the misses
 * immediately instead of waiting out {@link MISS_RETRY_MS}.
 */
let hintGeneration = 0;

/** The hint generation each pubkey was last stamped under. Session-scoped. */
const stampedGeneration = new Map<string, number>();

let ctx: ProfileSyncContext | undefined;

/**
 * Durable per-pubkey freshness. In KV so "checked this profile 5 minutes ago"
 * survives remounts and relaunches; cleared with the rest of KV on purge.
 */
const stamps = new KvPrefixCache<number>({ prefix: "profile-fresh:" });

/**
 * Declare that these pubkeys' profiles are wanted on screen. Returns a
 * release for the component's unmount. The context rides along because the
 * handler is module code with no access to React providers — the last caller
 * wins, which is fine: there is one pool and one query client per app.
 */
export function demandProfiles(pubkeys: string[], context: ProfileSyncContext): () => void {
  ctx = context;
  const pks = [...new Set(pubkeys)].filter(Boolean);
  if (pks.length === 0) return () => undefined;
  for (const pk of pks) demand.set(pk, (demand.get(pk) ?? 0) + 1);
  demandHolds++;
  topicWant ??= want(PROFILE_SYNC_TOPIC, "visible");
  // Wake the topic only when some demanded pubkey is actually due: a fresh
  // TOPIC stamp must not gate a brand-new row's fetch, but the common scroll
  // case — every row already fresh — must not force runs either (the old
  // unconditional `force: true` re-ran the topic every min-interval for as
  // long as rows kept mounting).
  if (pks.some(isDueNow)) invalidateSyncTopic(PROFILE_SYNC_TOPIC);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const pk of pks) {
      const count = demand.get(pk);
      if (count === undefined) continue;
      if (count <= 1) demand.delete(pk);
      else demand.set(pk, count - 1);
    }
    demandHolds--;
    if (demandHolds === 0) {
      topicWant?.();
      topicWant = undefined;
    }
  };
}

/**
 * Mirror of the run's candidate filter, evaluated synchronously at demand
 * time. Before the stamp warm lands (or before any run has classified a
 * pubkey) everything looks due, which costs at most one extra run whose
 * candidate filter then does the authoritative check against the store.
 */
function isDueNow(pk: string): boolean {
  const stamp = stamps.get(pk);
  if (stamp === undefined) return true;
  const found = foundProfiles.has(pk);
  if (Date.now() - stamp > (found ? FOUND_STALE_MS : MISS_RETRY_MS)) return true;
  return !found && stampedGeneration.get(pk) !== hintGeneration;
}

/**
 * Register relays that likely hold the profiles of the people on screen (a
 * community's relays, a NIP-29 server). Returns a release for unmount.
 */
export function addProfileRelayHints(relays: string[]): () => void {
  const urls = [...new Set(relays)].filter(Boolean);
  if (urls.length === 0) return () => undefined;
  let fresh = false;
  for (const url of urls) {
    const count = hintRelays.get(url) ?? 0;
    if (count === 0) fresh = true;
    hintRelays.set(url, count + 1);
  }
  if (fresh) {
    hintGeneration++;
    invalidateSyncTopic(PROFILE_SYNC_TOPIC);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const url of urls) {
      const count = hintRelays.get(url);
      if (count === undefined) continue;
      if (count <= 1) hintRelays.delete(url);
      else hintRelays.set(url, count - 1);
    }
  };
}

async function runProfileSync(signal: AbortSignal): Promise<void> {
  const c = ctx;
  // Context arrives with the first demand; a run with none has no demand
  // either (the topic was woken by a hint or a stale stamp) — nothing to do.
  if (!c || demand.size === 0) return;

  await stamps.ready();
  // Let the mounting burst finish enqueueing before the snapshot (see
  // SETTLE_MS). The scheduler is single-flight, so the rows that mount during
  // the round itself are picked up by the next one.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  if (signal.aborted) return;

  const demanded = [...demand.keys()];
  const store = await appEventStore();

  // One indexed local read serves three purposes: pick the right TTL per
  // pubkey (a found profile re-checks lazily, a miss retries soon), heal any
  // divergence between the store and the query cache (a profile another path
  // wrote lands on screen now), and let the newest-wins merge below compare
  // against what we already have.
  const cached = await store.query([{ kinds: [0], authors: demanded }]);
  const found = new Set<string>();
  for (const ev of cached) {
    found.add(ev.pubkey);
    // Classify for the demand-time due check too — BEFORE the early return
    // below, so a round with no candidates still teaches it the lazy TTL.
    foundProfiles.add(ev.pubkey);
    seedAuthorCache(c.queryClient, ev.pubkey, ev);
  }

  const now = Date.now();
  const candidates = demanded.filter((pk) => {
    const stamp = stamps.get(pk);
    if (stamp === undefined) return true;
    if (now - stamp > (found.has(pk) ? FOUND_STALE_MS : MISS_RETRY_MS)) return true;
    // A new hint relay appeared since this miss was stamped: ask again now.
    return !found.has(pk) && stampedGeneration.get(pk) !== hintGeneration;
  });
  if (candidates.length === 0) return;

  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

  // Pool pass: per-pubkey replaceable queries. The batcher's collector merges
  // these into chunked multi-author REQs with the profile EOSE grace and its
  // missing-kind-0 retry — machinery already tuned for exactly this shape.
  const poolPass = Promise.all(
    candidates.map(async (pk) => {
      try {
        const [ev] = await c.nostr.query(
          [{ kinds: [0], authors: [pk], limit: 1 }],
          { signal: runSignal },
        );
        return ev;
      } catch {
        return undefined;
      }
    }),
  );

  // Hint pass: ask the registered community/server relays about every stale
  // pubkey. Runs alongside the pool pass; a dead relay costs its chunk only.
  const hinted = [...hintRelays.keys()].slice(0, MAX_HINT_RELAYS);
  const hintPass = Promise.all(
    hinted.map(async (url) => {
      const out: NostrEvent[] = [];
      for (let i = 0; i < candidates.length; i += HINT_CHUNK) {
        const chunk = candidates.slice(i, i + HINT_CHUNK);
        try {
          out.push(
            ...(await c.nostr.relay(url).query(
              [{ kinds: [0], authors: chunk, limit: chunk.length }],
              { signal: runSignal },
            )),
          );
        } catch {
          // One relay must not fail the round.
        }
      }
      return out;
    }),
  );

  const [poolEvents, hintEvents] = await Promise.all([poolPass, hintPass]);

  const newest = new Map<string, NostrEvent>();
  for (const ev of [...poolEvents, ...hintEvents.flat()]) {
    if (!ev || ev.kind !== 0) continue;
    const prev = newest.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev);
  }

  // A torn-down run may have stopped anywhere; stamping its partial results
  // would gate the retry the next mount deserves.
  if (signal.aborted) return;

  await Promise.all(
    [...newest.values()].map((ev) => store.event(ev).catch(() => undefined)),
  );
  const at = Date.now();
  for (const pk of candidates) {
    stamps.set(pk, at);
    stampedGeneration.set(pk, hintGeneration);
  }
  for (const [pk, ev] of newest) {
    foundProfiles.add(pk);
    seedAuthorCache(c.queryClient, pk, ev);
  }
}

registerSyncTopic(PROFILE_SYNC_TOPIC, {
  // The floor between two rounds: coalesces a burst of row mounts into one
  // run plus one follow-up, without letting scroll-through demand spin.
  minIntervalMs: 5_000,
  // While author rows are on screen, re-run this often — the per-pubkey
  // stamps make it a no-op unless some miss is due for its retry (the old
  // per-hook 60s refetchInterval, now batched and durable).
  staleAfterMs: 60_000,
  handler: ({ signal }) => runProfileSync(signal),
});

/** Test seam: drop all demand, hints, context, and session generations. */
export function _resetProfileSyncForTests(): void {
  demand.clear();
  hintRelays.clear();
  stampedGeneration.clear();
  foundProfiles.clear();
  hintGeneration = 0;
  ctx = undefined;
  demandHolds = 0;
  topicWant?.();
  topicWant = undefined;
}
