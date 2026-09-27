/**
 * A one-relay query that can tell "the relay has nothing" from "the relay
 * refused to answer".
 *
 * `NRelay1.query()` means to throw on CLOSED, but `req()` ends its stream at a
 * CLOSED without yielding it, so the throw is unreachable and a refused REQ
 * (`auth-required:`, `rate-limited: too many subscriptions`, a relay that only
 * serves a kind to its authenticated author) resolves to `[]` exactly as an
 * empty EOSE does. A caller that treats a completed empty answer as proof of
 * absence then acts on a read it never got — the DM conversation index
 * republished every coordinate to such a relay on every pull, forever.
 *
 * `req()` ends in exactly three ways: after the EOSE this loop stops at, by
 * throwing (abort), or silently at CLOSED. So a stream that ends with no EOSE
 * and no throw was CLOSED, and this rejects rather than resolving empty.
 */

import type { NostrEvent, NostrFilter, NostrRelayCLOSED, NostrRelayEOSE, NostrRelayEVENT } from "@nostrify/types";
import { getFilterLimit } from "nostr-tools";

export interface ReqRelay {
  req(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<NostrRelayEVENT | NostrRelayEOSE | NostrRelayCLOSED>;
}

export class RelaySubscriptionClosedError extends Error {
  constructor() {
    super("Relay closed the subscription before EOSE");
    this.name = "RelaySubscriptionClosedError";
  }
}

/**
 * Collect a relay's stored events up to EOSE, like `NRelay1.query()`, but
 * reject with {@link RelaySubscriptionClosedError} when the relay CLOSED the
 * subscription instead of answering it. Events are deduplicated by id and
 * returned in arrival order.
 */
export async function queryRelayStrict(
  relay: ReqRelay,
  filters: NostrFilter[],
  opts?: { signal?: AbortSignal },
): Promise<NostrEvent[]> {
  const limit = filters.reduce((sum, filter) => sum + getFilterLimit(filter), 0);
  if (limit === 0) return [];
  const events = new Map<string, NostrEvent>();
  let answered = false;
  for await (const msg of relay.req(filters, opts)) {
    if (msg[0] === "EOSE") {
      answered = true;
      break;
    }
    if (msg[0] === "CLOSED") break;
    if (msg[0] === "EVENT") events.set(msg[2].id, msg[2]);
    // Hitting the combined limit is as good as EOSE: the relay has answered
    // everything this read asked for, and NRelay1.query() stops here too.
    if (events.size >= limit) {
      answered = true;
      break;
    }
  }
  opts?.signal?.throwIfAborted();
  if (!answered) throw new RelaySubscriptionClosedError();
  return [...events.values()];
}
