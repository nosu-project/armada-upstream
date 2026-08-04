/**
 * Session-scoped Concord V2 community activation — the registry behind the
 * wire's unread-deferral rule.
 *
 * A community whose rail button already shows the unread dot gains nothing
 * from background sync: the dot is binary, so new wraps can't make it "more
 * unread", and its history is caught up when (if) the user actually opens it.
 * The wire therefore defers such communities — until they are ACTIVATED:
 *
 *  - navigating into the community (`activateCommunity`, called by the
 *    community page) — the user is reading it now;
 *  - its dot clearing while deferred (`markCommunityLive`, called by the
 *    wire when a read on another device syncs back through NIP-78) — the
 *    dot must be able to re-light, which takes live sync.
 *
 * Activation is STICKY for the session. Without that, a community read
 * remotely while messages keep arriving would oscillate: catch-up → live sub
 * → new message → dotted → deferred → remote read → catch-up …, each cycle
 * costing a full newest-page pull that the standing subscription would have
 * covered for less. In-memory only, deliberately: a fresh pageload starts
 * with nothing activated, which is exactly the bandwidth-saving default.
 */

const activated = new Set<string>();
let activeIdHex: string | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One listener must not break the others.
    }
  }
}

/**
 * The user navigated into a community: it is the active one, and it stays
 * live (never deferred) for the rest of the session. Notifies listeners so
 * the wire rebuilds its spec immediately rather than on its next poll.
 */
export function activateCommunity(idHex: string): void {
  const changed = activeIdHex !== idHex || !activated.has(idHex);
  activeIdHex = idHex;
  activated.add(idHex);
  if (changed) notify();
}

/**
 * Pin a community live for the session WITHOUT notifying — for a caller that
 * is already mid-rebuild (the wire's own spec pass, which has just decided to
 * include the community) and only needs the stickiness recorded.
 */
export function markCommunityLive(idHex: string): void {
  activated.add(idHex);
}

/** The community most recently navigated into this session, if any. */
export function activeCommunityIdHex(): string | undefined {
  return activeIdHex;
}

/** Whether the community has been activated (navigated to / pinned live). */
export function isCommunityActivated(idHex: string): boolean {
  return activated.has(idHex);
}

/** Re-run on any activation. Returns an unsubscribe. */
export function onCommunityActivation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function _resetCommunityActivationForTests(): void {
  activated.clear();
  activeIdHex = undefined;
  listeners.clear();
}
