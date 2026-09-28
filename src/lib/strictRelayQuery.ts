/**
 * One-relay query that distinguishes "nothing stored" from "refused". NRelay1's
 * `req()` ends silently at CLOSED (auth-required, rate-limited…), so
 * `query()` resolves `[]` as if empty. A stream ending without EOSE or a throw
 * was CLOSED, so this rejects.
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
 * Like `NRelay1.query()`, but rejects with {@link RelaySubscriptionClosedError}
 * on CLOSED. Deduplicated by id, in arrival order.
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
    // Reaching the combined limit counts as answered (as in NRelay1.query()).
    if (events.size >= limit) {
      answered = true;
      break;
    }
  }
  opts?.signal?.throwIfAborted();
  if (!answered) throw new RelaySubscriptionClosedError();
  return [...events.values()];
}
