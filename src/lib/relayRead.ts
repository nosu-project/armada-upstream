/**
 * Reading a relay filter to completion, and knowing whether it completed.
 *
 * `NPool.query` is the wrong tool for a read whose ANSWER MATTERS. It applies
 * the pool's `eoseTimeout` (300ms here — see NostrProvider): the first relay to
 * EOSE arms a timer that aborts the WHOLE query, and `query` then swallows the
 * abort and returns whatever it happened to collect. On a cold or just-resumed
 * client that is the normal case, not an edge case — the warmest relay EOSEs
 * with nothing while the relay that actually holds the event is still finishing
 * a TLS handshake or a NIP-42 AUTH round trip (which on a bunker is seconds).
 * The caller gets `[]` and cannot tell it apart from "the event does not exist".
 *
 * That ambiguity is exactly what AGENTS.md warns about for the user's own
 * replaceable documents: an empty read that is really a FAILED read, treated as
 * authoritative, destroys the user's real state.
 *
 * So this drains `.req` directly and deliberately passes NO `eoseTimeout`, which
 * is what makes `NPool.req` wait for every routed relay to EOSE instead of
 * arming the early abort. The only bound is the caller's time budget, and the
 * result reports whether the read actually finished.
 */
import type { NostrEvent, NostrFilter, NRelay } from "@nostrify/nostrify";

export interface RelayReadResult {
  /** Everything that arrived before EOSE or the budget expired. */
  events: NostrEvent[];
  /**
   * True when EVERY routed relay answered (`NPool.req` emits EOSE only once
   * all of them have). Only then is an empty `events` authoritative: it means
   * the relays genuinely do not have the event, rather than that we failed to
   * ask them. A caller that must not act on ambiguity checks this.
   */
  complete: boolean;
}

/**
 * Read `filters` until every routed relay has EOSE'd, or `timeoutMs` elapses,
 * or `signal` aborts. Never throws: a relay error or an abort yields the
 * partial result with `complete: false`.
 */
export async function readToEose(
  nostr: NRelay,
  filters: NostrFilter[],
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<RelayReadResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const events: NostrEvent[] = [];
  let complete = false;

  const drain = (async () => {
    try {
      // No `eoseTimeout` in these opts — see the module doc. That absence is
      // the load-bearing part: with it, NPool aborts 300ms after the FIRST
      // relay EOSEs and a slow relay never gets to answer.
      for await (const msg of nostr.req(filters, { signal })) {
        if (msg[0] === "EVENT") {
          events.push(msg[2]);
        } else if (msg[0] === "EOSE") {
          complete = true;
          break;
        } else if (msg[0] === "CLOSED") {
          // Every routed relay closed the sub (NPool only forwards CLOSED once
          // all of them have). Nothing more is coming, but we were refused
          // rather than answered — not a completed read.
          break;
        }
      }
    } catch {
      // Aborted, or the subscription died. Fall through with what we have.
    }
  })();

  // The budget is enforced HERE rather than left to the subscription. Passing
  // the signal down should be enough — NPool ends its iteration on abort — but
  // a generator that doesn't honour it would otherwise hang this read forever,
  // and every skeleton in the app gates on a pending query. Racing means the
  // timeout is ours to keep. `events` is filled in place, so bailing early
  // still returns whatever had arrived.
  await Promise.race([
    drain,
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);

  return { events, complete };
}

/**
 * The newest of a set of events by `created_at`. Generic over the event shape
 * so it serves both relay reads and local-store reads (which yield rumors —
 * the same thing minus the signature).
 */
export function newestOf<T extends { created_at: number }>(events: T[]): T | undefined {
  let newest: T | undefined;
  for (const event of events) {
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  return newest;
}
