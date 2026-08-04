/**
 * Global control-plane sync — one batched catch-up across every Concord
 * community (V1 + V2), run on pageload and re-run on a slow poll
 * (see {@link ControlPlaneSync}). Closes the gap left by per-community
 * hooks that only fetch the community you've navigated into.
 *
 * V2 sweeps as ONE REQ per relay (one filter per community-plane, each with
 * its own cursor) via {@link sweepRelayScopes}. V1 uses a single `#z`
 * filter per relay. Results are invalidated progressively so rail buttons
 * paint as each relay answers.
 */

import { bytesToHex } from "@noble/hashes/utils.js";

import { controlPseudonym } from "@/concord-v1/lib/control";
import type { Community } from "@/concord-v1/lib/types";
import { KIND_COMMUNITY_CONTROL } from "@/concord-v1/lib/kinds";
import { controlScope, guestbookScope, sweepRelayScopes, type PlaneScope } from "@/concord-v2/lib/planeSync";
import { readStreamCursor, updateStreamCursor } from "@/concord-v2/lib/rumorStore";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { logSync, sinceMs } from "@/lib/syncLog";
import { emitWireScopes } from "@/wire/bus";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { QueryClient } from "@tanstack/react-query";

/** Minimal Nostr client shape (batcher-backed). */
interface NostrLike {
  relay(url: string): {
    query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  };
}

// V1 sweep cursor, per-relay (issue #19 isolation). Reuses the shared
// StreamCursor helpers (concord2-cursor:*) so there is ONE persisted-cursor
// implementation across the sync layer; only `newest` is used here.
const v1CursorScope = (relayUrl: string) => `v1control|${relayUrl}`;

function readV1Cursor(relayUrl: string): Promise<{ newest: number } | undefined> {
  return readStreamCursor(v1CursorScope(relayUrl));
}

async function advanceV1Cursor(relayUrl: string, newest: number): Promise<void> {
  await updateStreamCursor(v1CursorScope(relayUrl), { newest });
}

export interface ControlPlaneSyncResult {
  /** V1 community-id hex → whether new editions landed (for invalidation). */
  v1Touched: Set<string>;
  /** V2 community-id hex → whether new control editions landed. */
  v2Touched: Set<string>;
}

/**
 * Run one batched control-plane sweep across every community. Best-effort:
 * relay failures are swallowed; per-relay cursors mean a failed relay is
 * re-asked next time.
 */
export async function syncControlPlane(
  nostr: NostrLike,
  queryClient: QueryClient,
  v1: Community[],
  v2: CommunityV2[],
  opts?: {
    signal?: AbortSignal;
    /**
     * A V2 community to sweep FIRST, before the rest of the fan-out starts —
     * the one the user is looking at. On a cold pageload direct to a
     * community URL, everything the timeline is gated on (control fold →
     * channels → stream keys) sits behind this community's sweep, so it must
     * not queue behind every other membership's catch-up.
     */
    priorityIdHex?: string;
  },
): Promise<ControlPlaneSyncResult> {
  const result: ControlPlaneSyncResult = { v1Touched: new Set(), v2Touched: new Set() };
  if (v1.length === 0 && v2.length === 0) return result;

  const started = Date.now();
  logSync("sweep", `control-plane sweep start: v1=${v1.length} v2=${v2.length} community(ies)`);

  const jobs: Array<Promise<unknown>> = [];

  // ── V1: one filter selecting every community's control pseudonym (#z). ──────
  if (v1.length > 0) {
    const v1ByPseudonym = new Map<string, Community>();
    const v1Relays = new Set<string>();
    for (const c of v1) {
      v1ByPseudonym.set(controlPseudonym(c.serverRootKey, c.id, c.serverRootEpoch), c);
      for (const r of c.relays) v1Relays.add(r);
    }
    for (const url of v1Relays) {
      jobs.push(
        (async () => {
          const cursor = await readV1Cursor(url);
          const filter: NostrFilter = {
            kinds: [KIND_COMMUNITY_CONTROL],
            "#z": [...v1ByPseudonym.keys()],
            ...(cursor?.newest ? { since: cursor.newest } : {}),
          };
          try {
            const events = await nostr.relay(url).query([filter], {
              signal: AbortSignal.any([
                ...(opts?.signal ? [opts.signal] : []),
                AbortSignal.timeout(10_000),
              ]),
            });
            for (const ev of events) {
              for (const z of ev.tags) {
                if (z[0] !== "z") continue;
                const c = v1ByPseudonym.get(z[1]);
                if (c) result.v1Touched.add(bytesToHex(c.id));
              }
            }
            if (events.length > 0) {
              await advanceV1Cursor(url, Math.max(...events.map((e) => e.created_at)));
            }
          } catch {
            // Cursor stays put for the next sweep.
          }
        })(),
      );
    }
  }

  // ── V2: ONE batched REQ per relay, progressive paint on first data. ────────
  /** Run `fn` once (later relays add data silently). */
  const once = (fn: () => void) => {
    let fired = false;
    return () => {
      if (fired) return;
      fired = true;
      fn();
    };
  };
  let guestbookTouched = 0;
  const v2Jobs = (list: CommunityV2[]): Array<Promise<unknown>> => {
    const byRelay = new Map<string, PlaneScope[]>();
    for (const c of list) {
      const announceControl = once(() => {
        emitWireScopes([`c2ctl:${c.idHex}`]);
        queryClient.invalidateQueries({ queryKey: ["concord2", "control", c.idHex] });
      });
      const announceGuestbook = once(() => {
        guestbookTouched++;
        queryClient.invalidateQueries({ queryKey: ["concord2", "guestbook", c.idHex] });
      });
      for (const url of c.relays) {
        const scopes = byRelay.get(url) ?? [];
        scopes.push(
          controlScope(c, url, () => {
            result.v2Touched.add(c.idHex);
            announceControl();
          }),
          guestbookScope(c, url, announceGuestbook),
        );
        byRelay.set(url, scopes);
      }
    }
    return [...byRelay].map(([url, scopes]) => sweepRelayScopes(nostr, url, scopes));
  };

  // The active community's sweep runs to completion BEFORE the all-membership
  // fan-out is launched, so its REQs aren't contending with a dozen other
  // communities' catch-up for sockets and bandwidth. Costs the rest of the
  // sweep one community's round-trip of delay, at most.
  const priority = v2.filter((c) => c.idHex === opts?.priorityIdHex);
  const rest = opts?.priorityIdHex ? v2.filter((c) => c.idHex !== opts.priorityIdHex) : v2;
  if (priority.length > 0) {
    await Promise.all(v2Jobs(priority));
  }
  jobs.push(...v2Jobs(rest));

  await Promise.all(jobs);

  logSync(
    "sweep",
    `control-plane sweep done in ${sinceMs(started)}: v1Touched=${result.v1Touched.size} v2ControlTouched=${result.v2Touched.size} guestbookTouched=${guestbookTouched}`,
  );

  // Final bus ring for everything touched (first-data emits fired early).
  if (result.v2Touched.size > 0) {
    emitWireScopes([...result.v2Touched].map((idHex) => `c2ctl:${idHex}`));
  }

  // V1 invalidations (raw 3308s were mirrored into armada-events).
  for (const idHex of result.v1Touched) {
    queryClient.invalidateQueries({ queryKey: ["concord", "control", idHex] });
  }

  return result;
}
