/**
 * Global control-plane sync — one batched catch-up across EVERY Concord
 * community (V1 + V2) the user belongs to, run once on pageload.
 *
 * The per-community control hooks (`useConcordControlEvents` /
 * `useControlEvents2`) only fetch the community you've NAVIGATED INTO (their
 * `active` gate), so a community's roster/metadata/channels/banlist stay stale
 * until you open it. This closes that gap: on every pageload we issue exactly
 * TWO relay filters — one selecting all V1 control editions (`kinds:[3308]`,
 * `#z` = every community's control pseudonym) and one selecting all V2 control
 * wraps (`kinds:[1059]`, `authors` = every community's control stream keys
 * across held epochs) — and fan them out to the union of all community relays.
 *
 * A SINGLE shared cursor (not one per community) gates the fetch: on first run
 * we sync WITHOUT a `since`; afterwards we persist the newest `created_at` seen
 * and pass it as `since` on subsequent runs, so we only ever pull editions
 * newer than the last full sweep.
 *
 * Storage flows through the SAME sinks the per-community hooks read from, so a
 * later navigation (or the notification-subscription builder) sees the events:
 *   - V1 raw kind-3308 editions are cached into `armada-events` automatically
 *     (NostrBatcher mirrors every non-wrap event out of `nostr.query`), which is
 *     exactly where `useConcordControlEvents`' IndexedDB seed reads them back by
 *     `#z`.
 *   - V2 kind-1059 wraps are never cached raw; they're decrypted under each
 *     community's held control groups and the recovered editions written to the
 *     opened-event store via `writeOpened`, where `useControlEvents2`'s
 *     `queryByStreams` seed reads them back.
 *
 * After storing, the affected communities' control queries are invalidated so
 * any mounted hook (or the rail's fold snapshot) refolds against the freshly
 * stored events.
 */

import { bytesToHex } from "@noble/hashes/utils.js";

import { controlPseudonym } from "@/concord-v1/lib/control";
import type { Community } from "@/concord-v1/lib/types";
import { KIND_COMMUNITY_CONTROL } from "@/concord-v1/lib/kinds";
import { controlGroups } from "@/concord-v2/lib/control";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { writeOpened } from "@/concord-v2/lib/rumorStore";
import { openWrap, type OpenedEvent } from "@/concord-v2/lib/stream";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { QueryClient } from "@tanstack/react-query";

/** Minimal shape of the Nostr client the sync needs (batcher-backed). */
interface NostrLike {
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

/**
 * The single shared cursor for the whole control-plane sweep. Deliberately NOT
 * one of the per-community `concord2-cursor:control:<id>` cursors — this tracks
 * the newest control edition seen across ALL communities in one place.
 */
const CURSOR_KEY = "control-plane-sync:all";

interface ControlPlaneCursor {
  /** `created_at` of the newest control edition ingested by the last sweep. */
  newest: number;
}

/** Read the shared control-plane sync cursor, or undefined if none saved yet. */
export function readControlPlaneCursor(): Promise<ControlPlaneCursor | undefined> {
  return readFolded<ControlPlaneCursor>(CURSOR_KEY);
}

/** Advance the shared cursor forward (never backward). */
async function advanceCursor(newest: number): Promise<void> {
  const prev = await readControlPlaneCursor();
  await writeFolded(CURSOR_KEY, { newest: Math.max(prev?.newest ?? 0, newest) } satisfies ControlPlaneCursor);
}

/** The union of every community's relays (deduped) — where the two filters fan out. */
function unionRelays(v1: Community[], v2: CommunityV2[]): string[] {
  const set = new Set<string>();
  for (const c of v1) for (const r of c.relays) set.add(r);
  for (const c of v2) for (const r of c.relays) set.add(r);
  return [...set];
}

/** Query one filter across every relay, tolerating per-relay failures. */
async function queryAll(
  nostr: NostrLike,
  relays: string[],
  filter: NostrFilter,
  signal?: AbortSignal,
): Promise<NostrEvent[]> {
  const results = await Promise.all(
    relays.map((url) =>
      nostr
        .relay(url)
        .query([filter], { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]) })
        .catch(() => [] as NostrEvent[]),
    ),
  );
  return results.flat();
}

export interface ControlPlaneSyncResult {
  /** Newest `created_at` observed this sweep (0 if nothing new). */
  newest: number;
  /** V1 community-id hex → whether new editions landed (for invalidation). */
  v1Touched: Set<string>;
  /** V2 community-id hex → whether new editions landed (for invalidation). */
  v2Touched: Set<string>;
}

/**
 * Run one batched control-plane sweep. Issues at most two relay filters (one for
 * all V1 communities, one for all V2), stores the results in the proper sinks,
 * advances the shared cursor, and invalidates the touched communities' control
 * queries. Best-effort: relay failures and decrypt misses are swallowed.
 */
export async function syncControlPlane(
  nostr: NostrLike,
  queryClient: QueryClient,
  v1: Community[],
  v2: CommunityV2[],
  opts?: { signal?: AbortSignal },
): Promise<ControlPlaneSyncResult> {
  const result: ControlPlaneSyncResult = { newest: 0, v1Touched: new Set(), v2Touched: new Set() };
  if (v1.length === 0 && v2.length === 0) return result;

  const relays = unionRelays(v1, v2);
  if (relays.length === 0) return result;

  const cursor = await readControlPlaneCursor();
  const since = cursor?.newest;

  // ── V1: one filter selecting every community's control pseudonym (#z). ──────
  // The pseudonym → community index lets us map each returned edition back for
  // per-community invalidation, and NostrBatcher caches the raw 3308 editions
  // into `armada-events` on the way out — where useConcordControlEvents reads
  // them back by the same #z.
  const v1ByPseudonym = new Map<string, Community>();
  for (const c of v1) {
    v1ByPseudonym.set(controlPseudonym(c.serverRootKey, c.id, c.serverRootEpoch), c);
  }

  // ── V2: one filter selecting every community's control stream keys. ─────────
  const v2Groups: GroupKey[] = [];
  const v2ByPk = new Map<string, CommunityV2>();
  const v2GroupByPk = new Map<string, GroupKey>();
  for (const c of v2) {
    for (const g of controlGroups(c)) {
      v2Groups.push(g);
      v2ByPk.set(g.pk, c);
      v2GroupByPk.set(g.pk, g);
    }
  }

  const jobs: Promise<void>[] = [];

  if (v1ByPseudonym.size > 0) {
    const filter: NostrFilter = {
      kinds: [KIND_COMMUNITY_CONTROL],
      "#z": [...v1ByPseudonym.keys()],
      ...(since ? { since } : {}),
    };
    jobs.push(
      queryAll(nostr, relays, filter, opts?.signal).then((events) => {
        for (const ev of events) {
          if (ev.created_at > result.newest) result.newest = ev.created_at;
          for (const z of ev.tags) {
            if (z[0] === "z") {
              const c = v1ByPseudonym.get(z[1]);
              if (c) result.v1Touched.add(bytesToHex(c.id));
            }
          }
        }
      }),
    );
  }

  if (v2Groups.length > 0) {
    const filter: NostrFilter = {
      kinds: [KIND_WRAP],
      authors: [...v2ByPk.keys()],
      ...(since ? { since } : {}),
    };
    jobs.push(
      queryAll(nostr, relays, filter, opts?.signal).then((wraps) => {
        const opened: OpenedEvent[] = [];
        for (const wrap of wraps) {
          const group = v2GroupByPk.get(wrap.pubkey);
          if (!group) continue;
          let ev: OpenedEvent;
          try {
            ev = openWrap(wrap, group);
          } catch {
            continue; // not ours / malformed
          }
          opened.push(ev);
          if (wrap.created_at > result.newest) result.newest = wrap.created_at;
          const c = v2ByPk.get(wrap.pubkey);
          if (c) result.v2Touched.add(c.idHex);
        }
        // Decrypt-once into the opened-event store, where useControlEvents2's
        // queryByStreams seed reads them back with no decrypt.
        if (opened.length > 0) writeOpened(opened);
      }),
    );
  }

  await Promise.all(jobs);

  // Advance the shared cursor so the next sweep only pulls newer editions.
  if (result.newest > 0) await advanceCursor(result.newest);

  // Invalidate the touched communities' control queries so any mounted hook (or
  // the rail's fold snapshot) refolds against the freshly stored events.
  for (const idHex of result.v1Touched) {
    queryClient.invalidateQueries({ queryKey: ["concord", "control", idHex] });
  }
  for (const idHex of result.v2Touched) {
    queryClient.invalidateQueries({ queryKey: ["concord2", "control", idHex] });
  }

  return result;
}
