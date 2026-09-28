/**
 * Relay socket-reopen signal. A reconnected socket is unauthenticated, and a
 * re-issued REQ can be swallowed by the NIP-42 handshake, wedging long-lived
 * consumers; listeners re-REQ on the fresh socket instead. Plain module bus,
 * no coalescing.
 */

type ReopenListener = (relayUrl: string) => void;

const listeners = new Set<ReopenListener>();

/** Announce that this relay's socket just (re)opened. */
export function emitRelayReopened(relayUrl: string): void {
  for (const listener of listeners) {
    try {
      listener(relayUrl);
    } catch { /* ignore */ }
  }
}

/** Subscribe to socket-reopen announcements. Returns an unsubscribe. */
export function onRelayReopened(listener: ReopenListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
