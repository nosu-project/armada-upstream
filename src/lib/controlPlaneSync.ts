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
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { readFolded, writeFolded } from "@/lib/foldedCache";
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

/** V1 sweep cursor, per-relay (issue #19 isolation). */
const v1CursorKey = (relayUrl: string) => `control-plane-sync:v1|${relayUrl}`;

interface ControlPlaneCursor {
  /** `created_at` of the newest control edition this relay delivered. */
  newest: number;
}

function readV1Cursor(relayUrl: string): Promise<ControlPlaneCursor | undefined> {
  return readFolded<ControlPlaneCursor>(v1CursorKey(relayUrl));
}

async function advanceV1Cursor(relayUrl: string, newest: number): Promise<void> {
  const prev = await readV1Cursor(relayUrl);
  await writeFolded(v1CursorKey(relayUrl), { newest: Math.max(prev?.newest ?? 0, newest) });
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
  opts?: { signal?: AbortSignal },
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
  const byRelay = new Map<string, PlaneScope[]>();
  for (const c of v2) {
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
  for (const [url, scopes] of byRelay) {
    jobs.push(sweepRelayScopes(nostr, url, scopes));
  }

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
