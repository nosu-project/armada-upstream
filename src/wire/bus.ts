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
 *   - `dm`                   — a kind-4 DM arrived, or the NIP-17 rumor store
 *     changed (a DM sync/send/delete wrote rumors) — refresh conversation-level
 *     surfaces such as the inbox and unread dot
 *   - `dm-thread:<peer>`      — one DM conversation changed; only that mounted
 *     thread needs to re-read
 *   - `dm:wrap`              — the wire saw a live inbound NIP-17 gift wrap it
 *     can't decrypt itself; useDm17 force-syncs to fetch + decrypt + store it
 *   - `c2:<channelIdHex>`    — a Concord V2 channel's rumor store changed
 *   - `c2park:<streamPk>`    — a V2 wrap for this stream address was PARKED
 *     (the wire held no key for it); a hook holding that stream's key should
 *     drain the pending store
 *   - `c2ctl:<communityIdHex>` — a Concord V2 community's decrypted control
 *     plane changed (the background sweep stored new editions)
 *   - `git:<repository-address>` — an attached NIP-34 issue/PR root changed
 *
 * Emissions are coalesced on a short window so a backfill writing hundreds of
 * events produces one notification burst, not hundreds of invalidations.
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
