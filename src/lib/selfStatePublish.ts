import type { NostrEvent } from "@nostrify/nostrify";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import { publishSignedEventToRelays } from "@/lib/nip65";
import {
  PublishQueuedError,
  queueSignedEvent,
  recordQueuedPublishAttempt,
} from "@/lib/publishOutbox";

interface RelayPublishClient {
  relay(url: string): {
    event(event: NostrEvent, opts: { signal: AbortSignal }): Promise<unknown>;
  };
}

/**
 * Deliver one signed private-state edition to the account's self-state relays:
 * durable in the outbox first, then on disk, then published. A partial fan-out
 * throws {@link PublishQueuedError} when the outbox holds the remainder.
 * `beforePublish` runs once the edition is on disk (cache updates).
 */
export async function publishSelfStateEvent(
  nostr: RelayPublishClient,
  store: ArmadaEventStore,
  event: NostrEvent,
  relays: string[],
  opts: { label: string; beforePublish?: () => Promise<void> | void; inheritPendingTargets?: boolean },
): Promise<void> {
  let durablyQueued = false;
  try {
    await queueSignedEvent(event, undefined, relays, {
      inheritPendingTargets: opts.inheritPendingTargets,
    });
    durablyQueued = true;
  } catch {
    // Only called queued once the signed obligation was read back.
  }
  await store.event(event);
  await opts.beforePublish?.();
  const result = await publishSignedEventToRelays(nostr, event, relays, 8000);
  // Settle only this attempt's destinations; inherited old NIP-65 relays stay queued.
  await recordQueuedPublishAttempt(event.id, relays, result.rejected).catch(() => undefined);
  if (result.rejected.length === 0) return;
  const cause = new Error(
    result.accepted.length > 0
      ? `${result.rejected.length} account relay delivery${result.rejected.length === 1 ? "" : "ies"} remain`
      : `No account relay accepted the ${opts.label} update`,
  );
  console.warn(`Failed to publish ${opts.label}:`, cause);
  if (durablyQueued) throw new PublishQueuedError(event, cause);
  throw cause;
}
