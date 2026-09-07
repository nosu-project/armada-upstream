/**
 * A relay connection whose incoming events are verified in BATCHES, off the
 * socket's message handler — and, for a burst, off the main thread.
 *
 * `NRelay1` verifies every EVENT synchronously inside the WebSocket `message`
 * callback (`opts.verifyEvent`, a plain boolean function), so a cold sync's
 * firehose pays one ~2ms Schnorr verify per event on the main thread, one
 * message task at a time. A profiled community switch spent ~2.2s of a 13s
 * capture there — more than React spent rendering the page — while the worker
 * pool built for exactly this work (`verifyPool.ts`) sat idle, because nothing
 * on the relay path reached it.
 *
 * The subclass hands `NRelay1` an always-true `verifyEvent` and does the real
 * check itself, through a {@link RelayInbox}: each message is queued, and a
 * drain loop takes WHATEVER has accumulated, runs the batch through
 * `verifyEventsOnce` (hash-bind + memo on this thread, the EC residue through
 * the pool), then dispatches the survivors in wire order. The await on the
 * pool is the coalescing window — under load the next drain finds dozens of
 * messages waiting and verifies them in one round; a lone live message is a
 * batch of one and stays inline, exactly as the pool's small-batch rule
 * intends.
 *
 * Order is the contract. `NRelay1.query()` stops at EOSE and `req()` ends at
 * CLOSED, so an EVENT verified late would be lost if its EOSE could overtake
 * it: EVENT, EOSE and CLOSED go through one FIFO per relay. AUTH, OK, NOTICE
 * and COUNT carry no subscription ordering and are dispatched at once, so a
 * NIP-42 challenge is never held behind a backlog of signatures — and a
 * `CLOSED: auth-required` that IS held finds `authPromise` already armed when
 * it lands, which is the order the relay meant anyway.
 */

import { NRelay1, type NRelay1Opts } from "@nostrify/nostrify";
import type { NostrEvent, NostrRelayMsg } from "@nostrify/types";

import { type EcVerifyBatch, verifyEventsOnce } from "./verifyCache";
import { ecVerifyBatch } from "./verifyPool";

export interface RelayInboxOpts {
  /**
   * Events the verify is skipped for entirely (delivered as-is). The app uses
   * this for NIP-59 wraps, whose outer signature proves nothing the decrypt
   * path doesn't re-check — see `NostrProvider`.
   */
  skipVerify?: (event: NostrEvent) => boolean;
  /** The EC verifier for the memo's residue. Default: the worker pool. */
  ecVerify?: EcVerifyBatch;
}

/** Messages whose delivery must keep wire order relative to one another. */
function isOrdered(msg: NostrRelayMsg): boolean {
  return msg[0] === "EVENT" || msg[0] === "EOSE" || msg[0] === "CLOSED";
}

/**
 * The ordered, batching front of a relay connection: see the module comment.
 * Standalone (takes the dispatch as a callback) so its ordering and batching
 * contract is testable without a socket.
 */
export class RelayInbox {
  private pending: NostrRelayMsg[] = [];
  private draining = false;
  private readonly skipVerify: (event: NostrEvent) => boolean;
  private readonly ecVerify: EcVerifyBatch;

  constructor(
    private readonly dispatch: (msg: NostrRelayMsg) => void,
    opts: RelayInboxOpts = {},
  ) {
    this.skipVerify = opts.skipVerify ?? (() => false);
    this.ecVerify = opts.ecVerify ?? ecVerifyBatch;
  }

  push(msg: NostrRelayMsg): void {
    if (!isOrdered(msg)) {
      this.deliver(msg);
      return;
    }
    this.pending.push(msg);
    if (!this.draining) void this.drain();
  }

  /** Whether anything is queued or a verify round is in flight. */
  get busy(): boolean {
    return this.draining || this.pending.length > 0;
  }

  private deliver(msg: NostrRelayMsg): void {
    try {
      this.dispatch(msg);
    } catch {
      // A listener's failure is its own; it must not stall every message
      // behind it in the queue.
    }
  }

  private needsVerify(msg: NostrRelayMsg): msg is ["EVENT", string, NostrEvent] {
    return msg[0] === "EVENT" && !this.skipVerify(msg[2]);
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        // Take everything that has accumulated: while the previous round's
        // verify was awaited, the socket kept delivering into `pending`.
        const batch = this.pending;
        this.pending = [];
        const events: NostrEvent[] = [];
        for (const msg of batch) if (this.needsVerify(msg)) events.push(msg[2]);
        // `verifyEventsOnce` never throws: a dead verifier reads as
        // "unverified" for the residue, and those events are dropped exactly
        // as a bad signature would be.
        const verdicts = events.length > 0 ? await verifyEventsOnce(events, this.ecVerify) : [];
        let k = 0;
        for (const msg of batch) {
          if (this.needsVerify(msg) && verdicts[k++] !== true) continue;
          this.deliver(msg);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export interface VerifiedRelayOpts extends Omit<NRelay1Opts, "verifyEvent">, RelayInboxOpts {}

/** `NRelay1` with its EVENT verification routed through a {@link RelayInbox}. */
export class VerifiedRelay extends NRelay1 {
  private readonly inbox: RelayInbox;

  constructor(url: string, opts: VerifiedRelayOpts = {}) {
    const { skipVerify, ecVerify, ...relayOpts } = opts;
    // The base class's check is replaced, not disabled: every EVENT still has
    // to pass the inbox's verify before `super.receive` ever sees it.
    super(url, { ...relayOpts, verifyEvent: () => true });
    this.inbox = new RelayInbox((msg) => super.receive(msg), { skipVerify, ecVerify });
  }

  protected override receive(msg: NostrRelayMsg): void {
    this.inbox.push(msg);
  }
}
