/**
 * Publish-confirmation bus (the "eaten reply" reconciliation half).
 *
 * When a send fails its first attempt, `useNostrPublish` throws and the composer
 * marks the optimistic message "failed" (or leaves it "pending"), while the
 * durable outbox (`PublishOutbox`) keeps retrying in the background. Previously a
 * successful retry only removed the queued item — nothing told the timeline the
 * message had actually landed, so it stayed visibly "failed"/eaten forever.
 *
 * This bus bridges that gap: `PublishOutbox` calls `notifyPublishConfirmed(id)`
 * on a successful (possibly delayed) delivery, and timeline hooks
 * (`useGroupMessages`, DMs) subscribe to flip that message's status to "sent".
 * Keyed by the signed event id, which is stable across the optimistic insert and
 * the eventual relay echo.
 */

type Listener = (eventId: string) => void;

const listeners = new Set<Listener>();

/** Announce that a queued event was accepted by its relay (possibly on retry). */
export function notifyPublishConfirmed(eventId: string): void {
  for (const listener of listeners) {
    try {
      listener(eventId);
    } catch {
      // A misbehaving listener must not break delivery to the others.
    }
  }
}

/** Subscribe to publish confirmations. Returns an unsubscribe function. */
export function onPublishConfirmed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
