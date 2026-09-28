/**
 * Global control-plane sync: one batched catch-up across every Concord
 * community (pageload + slow poll), as one REQ per relay with per-community
 * cursors. Invalidates progressively so rail buttons paint as relays answer.
 */

import { controlScope, guestbookScope, sweepRelayScopes, type PlaneScope } from "@/concord/lib/planeSync";
import type { Community } from "@/concord/lib/types";
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

export interface ControlPlaneSyncResult {
  /** Community-id hex → whether new control editions landed. */
  concordTouched: Set<string>;
}

/** One batched control-plane sweep; best-effort (per-relay cursors retry failed relays next time). */
export async function syncControlPlane(
  nostr: NostrLike,
  queryClient: QueryClient,
  communities: Community[],
  opts?: {
    signal?: AbortSignal;
    /**
     * Sweep this community first: on a cold load to its URL, the whole timeline
     * is gated on its sweep, so it mustn't queue behind other memberships.
     */
    priorityIdHex?: string;
  },
): Promise<ControlPlaneSyncResult> {
  const result: ControlPlaneSyncResult = { concordTouched: new Set() };
  if (communities.length === 0) return result;

  const started = Date.now();
  logSync("sweep", `control-plane sweep start: communities=${communities.length} community(ies)`);

  const jobs: Array<Promise<unknown>> = [];

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
  const sweepJobs = (list: Community[]): Array<Promise<unknown>> => {
    const byRelay = new Map<string, PlaneScope[]>();
    for (const c of list) {
      const announceControl = once(() => {
        emitWireScopes([`c2ctl:${c.idHex}`]);
        queryClient.invalidateQueries({ queryKey: ["concord", "control", c.idHex] });
      });
      const announceGuestbook = once(() => {
        guestbookTouched++;
        queryClient.invalidateQueries({ queryKey: ["concord", "guestbook", c.idHex] });
      });
      for (const url of c.relays) {
        const scopes = byRelay.get(url) ?? [];
        scopes.push(
          controlScope(c, url, () => {
            result.concordTouched.add(c.idHex);
            announceControl();
          }),
          guestbookScope(c, url, announceGuestbook),
        );
        byRelay.set(url, scopes);
      }
    }
    return [...byRelay].map(([url, scopes]) => sweepRelayScopes(nostr, url, scopes));
  };

  // The active community completes before the fan-out so it doesn't contend for sockets.
  const priority = communities.filter((c) => c.idHex === opts?.priorityIdHex);
  const rest = opts?.priorityIdHex ? communities.filter((c) => c.idHex !== opts.priorityIdHex) : communities;
  if (priority.length > 0) {
    await Promise.all(sweepJobs(priority));
  }
  jobs.push(...sweepJobs(rest));

  await Promise.all(jobs);

  logSync(
    "sweep",
    `control-plane sweep done in ${sinceMs(started)}: concordControlTouched=${result.concordTouched.size} guestbookTouched=${guestbookTouched}`,
  );

  if (result.concordTouched.size > 0) {
    emitWireScopes([...result.concordTouched].map((idHex) => `c2ctl:${idHex}`));
  }

  return result;
}
