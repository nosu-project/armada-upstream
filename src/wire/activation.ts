/**
 * Session-scoped activation — the registry behind the wire's unread-deferral
 * rule, for every community type that has one.
 *
 * A community whose rail button already shows the unread dot gains nothing
 * from background sync: the dot is binary, so new activity can't make it "more
 * unread", and its history is caught up when (if) the user actually opens it.
 * The wire therefore defers such communities — until they are ACTIVATED:
 *
 *  - navigating into the community ({@link activateScope}, called by the
 *    community/server page) — the user is reading it now;
 *  - its dot clearing while deferred ({@link markScopeLive}, called by the
 *    wire when a read on another device syncs back through NIP-78) — the
 *    dot must be able to re-light, which takes live sync.
 *
 * Activation is STICKY for the session. Without that, a community read
 * remotely while messages keep arriving would oscillate: catch-up → live sub
 * → new message → dotted → deferred → remote read → catch-up …, each cycle
 * costing a full newest-page pull that the standing subscription would have
 * covered for less. In-memory only, deliberately: a fresh pageload starts
 * with nothing activated, which is exactly the bandwidth-saving default.
 *
 * Scopes are `<kind>:<id>` strings, one spelling per protocol, so the two
 * deferral implementations share these semantics rather than each keeping
 * their own copy of them:
 *
 *   - `c2:<communityIdHex>`   — a Concord V2 community
 *   - `nip29:<relayUrl>`      — a NIP-29 server (relay-per-community, so the
 *                               relay IS the community; its channels defer and
 *                               activate together, exactly as its rail button
 *                               and its dot are per-server)
 */
import { normalizeRelayUrl } from "@/lib/platform";

/** Scope key for a Concord V2 community. */
export function concord2Scope(communityIdHex: string): string {
  return `c2:${communityIdHex}`;
}

/**
 * Scope key for a NIP-29 server. Normalized HERE rather than by each caller:
 * a page derives its relay from a route param and the wire derives the same
 * relay from the group list, and a scope spelled two ways is a server that
 * activates under one key while the wire keeps deferring it under the other.
 */
export function nip29Scope(relayUrl: string): string {
  return `nip29:${normalizeRelayUrl(relayUrl) ?? relayUrl}`;
}

const activated = new Set<string>();
/** Most recently activated scope per kind prefix (`"c2:"`, `"nip29:"`). */
const activeByKind = new Map<string, string>();
const listeners = new Set<() => void>();

/** The `<kind>:` prefix of a scope, or the whole string if it has no colon. */
function kindOf(scope: string): string {
  const sep = scope.indexOf(":");
  return sep < 0 ? scope : scope.slice(0, sep + 1);
}

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
 * The user navigated into this community: it is the active one of its kind,
 * and it stays live (never deferred) for the rest of the session. Notifies
 * listeners so the wire rebuilds its spec immediately rather than on its next
 * poll.
 */
export function activateScope(scope: string): void {
  const kind = kindOf(scope);
  const changed = activeByKind.get(kind) !== scope || !activated.has(scope);
  activeByKind.set(kind, scope);
  activated.add(scope);
  if (changed) notify();
}

/**
 * Pin a scope live for the session WITHOUT notifying — for a caller that is
 * already mid-rebuild (the wire's own spec pass, which has just decided to
 * include it) and only needs the stickiness recorded.
 */
export function markScopeLive(scope: string): void {
  activated.add(scope);
}

/** Whether the scope has been activated (navigated to / pinned live). */
export function isScopeActivated(scope: string): boolean {
  return activated.has(scope);
}

/**
 * The id of the most recently activated scope of one kind — e.g.
 * `activeScopeId("c2:")` is the community the user is in, which the global
 * control-plane sweep gives first turn. Undefined before any activation.
 */
export function activeScopeId(kindPrefix: string): string | undefined {
  const scope = activeByKind.get(kindPrefix);
  return scope?.slice(kindPrefix.length);
}

/** Re-run on any activation. Returns an unsubscribe. */
export function onActivation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. */
export function _resetActivationForTests(): void {
  activated.clear();
  activeByKind.clear();
  listeners.clear();
}
