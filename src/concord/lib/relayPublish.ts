import type { NostrEvent } from "@nostrify/nostrify";

interface RelayPublisher {
  relay(url: string): {
    event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  };
}

/**
 * Publish to every relay, but resolve as soon as ONE accepts, so a dead relay's
 * 8s timeout doesn't gate success. The rest continue in the background.
 */
export async function publishToAnyRelay(
  nostr: RelayPublisher,
  relays: string[],
  event: NostrEvent,
  errorMessage: string,
): Promise<void> {
  try {
    await Promise.any(
      relays.map((url) => nostr.relay(url).event(event, { signal: AbortSignal.timeout(8000) })),
    );
  } catch (error) {
    // Keep the per-relay AggregateError reachable for debugging.
    throw new Error(errorMessage, { cause: error });
  }
}
