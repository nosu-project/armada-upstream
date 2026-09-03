/**
 * The wire's change-notification bus.
 *
 * Every event the wire ingests lands in IndexedDB first (armada-events for
 * plaintext planes, the rumor store for decrypted Concord); the bus then
 * tells interested hooks WHICH conversation changed so they can re-read the
 * store. This replaces the old per-hook live subscriptions and the
 * cross-cache `setQueryData` plumbing: stores are the single source of truth,
 * the bus is just a doorbell.
 *
 * Scopes are plain strings:
 *   - `nip29:<groupId>`      — a NIP-29 group's timeline changed
 *   - `dm`                   — a kind-4 DM arrived, or the NIP-17 rumor store
 *     changed (a DM sync/send/delete wrote rumors) — refresh conversation-level
 *     surfaces such as the inbox and unread dot
 *   - `dm-thread:<peer>`      — one DM conversation changed; only that mounted
 *     thread needs to re-read
 *   - `dm:wrap`              — the wire saw a live inbound NIP-17 gift wrap it
 *     can't decrypt itself; useDm17 force-syncs to fetch + decrypt + store it
 *   - `c2inv:wrap`           — the wire buffered a live inbound Concord direct-
 *     invite gift wrap (kind-1059 `#k`=3313) it can't decrypt; useDirectInvites
 *     drains the in-hand wrap, decrypts it (consent-gated) and re-reads
 *   - `c2:<channelIdHex>`    — a Concord channel's rumor store changed
 *   - `c2park:<streamPk>`    — a Concord wrap for this stream address was PARKED
 *     (the wire held no key for it); a hook holding that stream's key should
 *     drain the pending store
 *   - `c2ctl:<communityIdHex>` — a Concord community's decrypted control
 *     plane changed (the background sweep stored new editions)
 *   - `git:<repository-address>` — an attached NIP-34 issue/PR root changed
 *
 * Emissions are coalesced on a short window so a backfill writing hundreds of
 * events produces one notification burst, not hundreds of invalidations.
 *
 * The bus is also the SHARED doorbell across same-origin contexts: each
 * coalesced batch is mirrored over a BroadcastChannel, so a write committed in
 * another tab — the one in-process case the local emit can't cover (your own
 * send there, its expiry sweep's deletions) — still rings here, and the
 * store-backed re-read finds the rows already in the shared store. Received
 * scopes are delivered to local listeners but never rebroadcast (two tabs
 * would ping-pong a batch forever), and the scopes that trigger work on an
 * event IN HAND (`dm:wrap`, `c2inv:wrap`, `c2park:*`) stay local — mirroring
 * those would make every tab force-sync the same wrap. On the single-context
 * platforms the channel simply has no other subscriber.
 */

export type WireScope = string;

/** Scope naming one DM conversation without exposing it outside this process. */
export function dmThreadScope(peer: string): WireScope {
  return `dm-thread:${peer}`;
}

type WireListener = (scopes: ReadonlySet<WireScope>) => void;

/** Coalescing window for scope flushes (ms). */
const FLUSH_MS = 50;

const listeners = new Set<WireListener>();
let pending = new Set<WireScope>();
/** The subset of `pending` this context emitted itself — what gets mirrored. */
let localPending = new Set<WireScope>();
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * Scopes that trigger work on an event this context holds IN HAND (a live wrap
 * in a buffer, a parked stream), not a "the shared store changed" doorbell.
 * Mirroring them would make every tab force-sync or drain the same wrap.
 */
function isLocalOnlyScope(scope: WireScope): boolean {
  return scope === "dm:wrap" || scope === "c2inv:wrap" || scope.startsWith("c2park:");
}

/**
 * The cross-context doorbell. Same-origin tabs/windows share the store, so a
 * batch committed there is readable here the moment it's announced. Created at
 * module load so an idle tab still hears; absent (jsdom, old runtimes) the bus
 * is exactly the in-process doorbell it was.
 */
const bridge: BroadcastChannel | undefined = (() => {
  if (typeof BroadcastChannel === "undefined") return undefined;
  try {
    const channel = new BroadcastChannel("armada-wire-bus");
    channel.onmessage = (event: MessageEvent) => {
      const scopes = Array.isArray(event.data)
        ? (event.data as unknown[]).filter((s): s is string => typeof s === "string")
        : [];
      if (scopes.length === 0) return;
      // Into `pending` only, never `localPending`: a received batch reaches
      // this context's listeners but is not rebroadcast — two tabs would
      // otherwise ping-pong it forever.
      for (const s of scopes) pending.add(s);
      schedule();
    };
    // Node's BroadcastChannel holds the process open; browsers have no unref.
    (channel as { unref?: () => void }).unref?.();
    return channel;
  } catch {
    return undefined;
  }
})();

function schedule(): void {
  if (pending.size > 0 && timer === undefined) {
    timer = setTimeout(flush, FLUSH_MS);
  }
}

function flush(): void {
  timer = undefined;
  if (pending.size === 0) return;
  const batch = pending;
  const mirrored = [...localPending].filter((s) => !isLocalOnlyScope(s));
  pending = new Set();
  localPending = new Set();
  if (mirrored.length > 0) {
    try {
      bridge?.postMessage(mirrored);
    } catch {
      // A closed/failed channel must never break the local doorbell.
    }
  }
  for (const listener of listeners) {
    try {
      listener(batch);
    } catch {
      // A listener must never break the bus for the others.
    }
  }
}

/** Announce that these conversations' stores changed. Coalesced. */
export function emitWireScopes(scopes: Iterable<WireScope>): void {
  for (const s of scopes) {
    pending.add(s);
    localPending.add(s);
  }
  schedule();
}

/** Subscribe to store-change announcements. Returns an unsubscribe. */
export function onWireScopes(listener: WireListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test helper: drop any pending batch and all listeners. */
export function resetWireBus(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  pending = new Set();
  localPending = new Set();
  listeners.clear();
}
