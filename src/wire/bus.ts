/**
 * The wire's change-notification bus.
 *
 * Every event the wire ingests lands in IndexedDB first (armada-events for
 * plaintext planes, the rumor store for decrypted Concord V2); the bus then
 * tells interested hooks WHICH conversation changed so they can re-read the
 * store. This replaces the old per-hook live subscriptions and the
 * cross-cache `setQueryData` plumbing: stores are the single source of truth,
 * the bus is just a doorbell.
 *
 * Scopes are plain strings:
 *   - `nip29:<groupId>`      — a NIP-29 group's timeline changed
 *   - `dm`                   — a kind-4 DM arrived
 *   - `c1:<channelIdHex>`    — a Concord V1 channel's sealed history changed
 *   - `c2:<channelIdHex>`    — a Concord V2 channel's rumor store changed
 *   - `c2ctl:<communityIdHex>` — a Concord V2 community's decrypted control
 *     plane changed (the background sweep stored new editions)
 *
 * Emissions are coalesced on a short window so a backfill writing hundreds of
 * events produces one notification burst, not hundreds of invalidations.
 */

export type WireScope = string;

type WireListener = (scopes: ReadonlySet<WireScope>) => void;

/** Coalescing window for scope flushes (ms). */
const FLUSH_MS = 50;

const listeners = new Set<WireListener>();
let pending = new Set<WireScope>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  timer = undefined;
  if (pending.size === 0) return;
  const batch = pending;
  pending = new Set();
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
  for (const s of scopes) pending.add(s);
  if (pending.size > 0 && timer === undefined) {
    timer = setTimeout(flush, FLUSH_MS);
  }
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
  listeners.clear();
}
